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

interface FindingLogEntry {
  id: number;
  key: string;
  firstMs: number;
  lastMs: number;
  timeLabel: string;
  tone: "badge-warn" | "badge-accent" | "badge-good";
  badge: string;
  sourceLabel: string;
  sourceColor?: string;
  maxDbm: number;
  count: number;
  detail: string;
}

function fmtWallTimeMs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const tenths = Math.floor(d.getMilliseconds() / 100);
  return `${hh}:${mm}:${ss}.${tenths}`;
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

  private signalWindowSec = 2.5;
  private signalAutoX = true;
  private signalAutoY = true;
  private signalSmoothYMin: number | null = null;
  private signalSmoothYMax: number | null = null;
  private signalEndN: number | null = null;
  private signalRefN = 0;
  private signalYMin = -100;
  private signalYMax = -78;
  private signalYZoomBox: { y0: number; y1: number } | null = null;
  private signalDrag: {
    mode: "pan" | "ybox" | "xstretch" | "ystretch";
    startX: number;
    startY: number;
    startEndN: number;
    startWindowSec: number;
    startYMin: number;
    startYMax: number;
    anchorFrac: number;
  } | null = null;
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
  private scanAutoY = true;
  private scanYMin = DBM_MIN;
  private scanYMax = DBM_MAX;
  private scanZoomBox: { x0: number; x1: number } | null = null;
  private scanHover: { x: number; y: number } | null = null;
  private waterfallHover: { x: number; y: number } | null = null;
  private wfDragging: {
    mode: "pan" | "scrollbar" | "zoom" | "ystretch" | "xstretch";
    startX: number;
    startY: number;
    startScroll: number;
    startVisibleRows: number;
    startMHz0: number;
    startMHz1: number;
    anchorFrac: number;
  } | null = null;
  private specDragging: {
    mode: "pan" | "zoom" | "ystretch" | "xstretch";
    startX: number;
    startY: number;
    startYMin: number;
    startYMax: number;
    startMHz0: number;
    startMHz1: number;
    anchorFrac: number;
  } | null = null;

  private dirtySignal = true;
  private dirtyNoiseTable = true;
  private dirtySpectrum = true;
  private dirtyWaterfall = true;
  private dirtyHealth = true;
  private lastNoiseTableRenderAt = 0;
  private rafId = 0;
  private observer: IntersectionObserver | null = null;

  private signalFindings: FindingLogEntry[] = [];
  private signalFindingSeq = 0;
  private scanFindings: FindingLogEntry[] = [];
  private scanFindingSeq = 0;

  constructor(el: HTMLElement) {
    super(el);
    this.console = new TimerConsole({
      onStatus: (s) => {
        const freqsChanged = this.status?.freqs.join() !== s.freqs.join();
        const rfChanged = this.status?.rf.enabled !== s.rf.enabled;
        this.status = s;
        // Pick up a live scan still running from before (page reload); skip stale replies right after a toggle.
        let scanChanged = false;
        if (s.scanLive !== undefined && s.scanLive !== this.scanLive && Date.now() - this.scanToggleAt > 3000) {
          this.scanLive = s.scanLive;
          scanChanged = true;
        }
        this.renderConnection();
        this.renderStatus();
        this.renderLiveHead();
        if (freqsChanged || rfChanged || scanChanged) {
          if (freqsChanged) this.renderLive();
          if (!this.channelsDirty) this.renderChannels();
          this.renderSignalControls();
          this.renderScan();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
        }
        void this.pollServerHealth(s);
      },
      onLive: (s) => {
        this.live = s;
        this.liveCount++;
        this.signalRing.push(s, this.status?.sweepHz ?? 50, this.liveMode);
        this.recordSignalFindingFromSample(s);
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
        this.recordScanFindingFromPass(s);
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
            <div class="debug-subbox debug-health-subbox" data-slot="health">
              <div class="debug-subbox-head">
                <span class="debug-subbox-title">${icons.chart(14)}<span>Health trends</span></span>
                <span class="note">Last 5 min · 2 s interval</span>
              </div>
              <div class="debug-health-grid" data-health-grid>
                <div class="debug-health-card" data-health-card="sweep">
                  <div class="debug-health-info">
                    <span class="debug-health-title">Sweep duration</span>
                    <div class="debug-health-value" data-health-val="sweep">—</div>
                    <span class="debug-health-meta" data-health-meta="sweep">Waiting for data…</span>
                  </div>
                  <div class="debug-health-spark-wrap">
                    <canvas class="debug-canvas debug-health-spark" data-spark-canvas="sweep"></canvas>
                  </div>
                </div>
                <div class="debug-health-card" data-health-card="heap">
                  <div class="debug-health-info">
                    <span class="debug-health-title">Free heap</span>
                    <div class="debug-health-value" data-health-val="heap">—</div>
                    <span class="debug-health-meta" data-health-meta="heap">Waiting for data…</span>
                  </div>
                  <div class="debug-health-spark-wrap">
                    <canvas class="debug-canvas debug-health-spark" data-spark-canvas="heap"></canvas>
                  </div>
                </div>
                <div class="debug-health-card" data-health-card="udp">
                  <div class="debug-health-info">
                    <span class="debug-health-title">Laptop UDP link</span>
                    <div class="debug-health-value" data-health-val="udp">—</div>
                    <span class="debug-health-meta" data-health-meta="udp">Waiting for data…</span>
                  </div>
                  <div class="debug-health-spark-wrap">
                    <canvas class="debug-canvas debug-health-spark" data-spark-canvas="udp"></canvas>
                  </div>
                </div>
                <div class="debug-health-card" data-health-card="usb">
                  <div class="debug-health-info">
                    <span class="debug-health-title">USB live stream</span>
                    <div class="debug-health-value" data-health-val="usb">—</div>
                    <span class="debug-health-meta" data-health-meta="usb">Waiting for data…</span>
                  </div>
                  <div class="debug-health-spark-wrap">
                    <canvas class="debug-canvas debug-health-spark" data-spark-canvas="usb"></canvas>
                  </div>
                </div>
              </div>
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
            <div data-slot="signal-legend"></div>
            <div data-slot="noise-table"></div>
          </div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Spectrum scan &amp; waterfall</h2>
            <p>Sweeps the receiver across 5180–5917 MHz. Use it to find a VTX on an unexpected frequency, or to check a venue for 5 GHz Wi-Fi before racing. Note that Raceband <strong>R3–R6 overlap 5 GHz Wi-Fi UNII-3</strong> (channels 149–165, 5735–5835 MHz).</p>
            <p><strong>Scan once</strong> takes one snapshot and appends a row to the waterfall. <strong>Stream</strong> scans continuously with live, average and max-hold traces (automatically pausing the 8-channel stream while it runs).</p>
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
    const minEnd = Math.min(latest, earliest + this.signalWindowSec * sweepHz);
    return Math.min(latest, Math.max(minEnd, endN));
  }

  private pauseSignalAt(endN: number): void {
    const wasLive = this.signalEndN === null;
    if (wasLive) {
      this.signalRefN = this.signalRing.latestN();
    }
    this.signalEndN = this.clampSignalEndN(endN);
    if (wasLive) {
      this.renderSignalControls();
    }
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
    const f0 = b.vStart + ((xa - L) / plotW) * span;
    const f1 = b.vStart + ((xb - L) / plotW) * span;
    if (f1 - f0 >= Math.max(10, s.step * 2)) {
      this.scanZoomStartMHz = f0;
      this.scanZoomStopMHz = f1;
      this.renderScan();
    }
  }

  private applyFreqStretch(startMHz0: number, startMHz1: number, anchorFrac: number, factor: number): void {
    const s = this.spectrumAcc.latest;
    if (!s || !s.dbm.length) return;
    const fullStart = s.start;
    const fullStop = s.start + s.step * (s.dbm.length - 1);
    const fullSpan = Math.max(10, fullStop - fullStart);
    const curSpan = Math.max(10, startMHz1 - startMHz0);
    const minSpan = Math.max(10, s.step * 3);
    const nextSpan = Math.max(minSpan, Math.min(fullSpan, curSpan * factor));
    const anchorMHz = startMHz0 + anchorFrac * curSpan;
    let f0 = anchorMHz - anchorFrac * nextSpan;
    let f1 = f0 + nextSpan;
    if (f0 < fullStart) {
      f0 = fullStart;
      f1 = Math.min(fullStop, fullStart + nextSpan);
    }
    if (f1 > fullStop) {
      f1 = fullStop;
      f0 = Math.max(fullStart, fullStop - nextSpan);
    }
    if (f0 <= fullStart + 0.5 && f1 >= fullStop - 0.5) {
      this.scanZoomStartMHz = null;
      this.scanZoomStopMHz = null;
    } else {
      this.scanZoomStartMHz = f0;
      this.scanZoomStopMHz = f1;
    }
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
  }

  private applyFreqPan(startMHz0: number, startMHz1: number, deltaMHz: number): void {
    const s = this.spectrumAcc.latest;
    if (!s || !s.dbm.length) return;
    const fullStart = s.start;
    const fullStop = s.start + s.step * (s.dbm.length - 1);
    const span = Math.max(10, startMHz1 - startMHz0);
    if (span >= fullStop - fullStart - 0.5) return;
    let f0 = startMHz0 + deltaMHz;
    let f1 = f0 + span;
    if (f0 < fullStart) {
      f0 = fullStart;
      f1 = Math.min(fullStop, fullStart + span);
    }
    if (f1 > fullStop) {
      f1 = fullStop;
      f0 = Math.max(fullStart, fullStop - span);
    }
    this.scanZoomStartMHz = f0;
    this.scanZoomStopMHz = f1;
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
  }

  private applyDbmStretch(
    startMin: number,
    startMax: number,
    anchorFrac: number,
    factor: number,
    target: "signal" | "scan"
  ): void {
    const curSpan = Math.max(4, startMax - startMin);
    const nextSpan = Math.max(4, Math.min(DBM_MAX - DBM_MIN, curSpan * factor));
    const anchorDbm = startMin + anchorFrac * curSpan;
    let nextMin = anchorDbm - anchorFrac * nextSpan;
    let nextMax = nextMin + nextSpan;
    if (nextMin < DBM_MIN) {
      nextMin = DBM_MIN;
      nextMax = Math.min(DBM_MAX, DBM_MIN + nextSpan);
    }
    if (nextMax > DBM_MAX) {
      nextMax = DBM_MAX;
      nextMin = Math.max(DBM_MIN, DBM_MAX - nextSpan);
    }
    if (target === "signal") {
      this.signalAutoY = false;
      this.signalSmoothYMin = nextMin;
      this.signalSmoothYMax = nextMax;
      this.signalYMin = nextMin;
      this.signalYMax = nextMax;
      this.dirtySignal = true;
    } else {
      this.scanAutoY = false;
      this.scanYMin = nextMin;
      this.scanYMax = nextMax;
      this.spectrumAcc.setColorRange(nextMin, Math.min(-25, nextMax));
      this.dirtySpectrum = true;
      this.dirtyWaterfall = true;
    }
  }

  private applyDbmPan(startMin: number, startMax: number, deltaDbm: number, target: "signal" | "scan"): void {
    const span = Math.max(4, startMax - startMin);
    let nextMin = startMin + deltaDbm;
    let nextMax = nextMin + span;
    if (nextMin < DBM_MIN) {
      nextMin = DBM_MIN;
      nextMax = Math.min(DBM_MAX, DBM_MIN + span);
    }
    if (nextMax > DBM_MAX) {
      nextMax = DBM_MAX;
      nextMin = Math.max(DBM_MIN, DBM_MAX - span);
    }
    if (target === "signal") {
      this.signalAutoY = false;
      this.signalSmoothYMin = nextMin;
      this.signalSmoothYMax = nextMax;
      this.signalYMin = nextMin;
      this.signalYMax = nextMax;
      this.dirtySignal = true;
    } else {
      this.scanAutoY = false;
      this.scanYMin = nextMin;
      this.scanYMax = nextMax;
      this.spectrumAcc.setColorRange(nextMin, Math.min(-25, nextMax));
      this.dirtySpectrum = true;
      this.dirtyWaterfall = true;
    }
  }

  private updateAutoSignalAxes(canvasWidth: number): void {
    const sweepHz = this.status?.sweepHz ?? 50;
    const ptsAll = this.signalRing.points;

    if (this.signalAutoX) {
      let effectiveRateHz = this.liveMode === 2 ? sweepHz : Math.max(1, Math.round(sweepHz / 5));
      if (ptsAll.length >= 12) {
        const a = ptsAll[Math.max(0, ptsAll.length - 30)];
        const b = ptsAll[ptsAll.length - 1];
        const dtSec = (b.wallMs - a.wallMs) / 1000;
        const count = ptsAll.length - 1 - Math.max(0, ptsAll.length - 30);
        if (dtSec >= 0.15 && dtSec <= 5 && count >= 5) {
          effectiveRateHz = Math.max(4, Math.min(sweepHz, count / dtSec));
        }
      }
      const plotW = Math.max(240, (canvasWidth || 700) - 58);
      // Target ~6.5 px per sample so consecutive sweeps and crossings are clearly separated
      const targetSamples = Math.max(45, Math.min(160, Math.round(plotW / 6.5)));
      const rawSec = targetSamples / Math.max(4, effectiveRateHz);
      const snappedSec = Math.max(1.5, Math.min(15, Math.round(rawSec * 2) / 2));
      if (Math.abs(this.signalWindowSec - snappedSec) >= 0.4) {
        this.signalWindowSec = snappedSec;
      }
    }

    if (this.signalAutoY) {
      const pts = this.signalRing.windowPoints(this.signalWindowSec, sweepHz, this.signalEndN);
      if (pts.length > 0) {
        let minD = 1000;
        let maxD = -1000;
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k];
          for (let ch = 0; ch < 8; ch++) {
            if (!this.signalEnabledCh[ch]) continue;
            const v = p.dbm[ch];
            if (v !== undefined && v > -127) {
              if (v < minD) minD = v;
              if (v > maxD) maxD = v;
            }
            const fl = p.floor[ch];
            if (fl !== undefined && fl > -127) {
              if (this.signalShowFloor) {
                if (fl < minD) minD = fl;
                if (fl > maxD) maxD = fl;
              }
              if (this.signalShowHitLine && fl + 10 > maxD) {
                maxD = fl + 10;
              }
            }
          }
        }
        if (this.signalShowThresholds && maxD > -1000) {
          const freqs = this.status?.freqs ?? RACEBAND;
          for (let ch = 0; ch < 8; ch++) {
            if (!this.signalEnabledCh[ch]) continue;
            const f = freqs[ch] ?? RACEBAND[ch];
            const pilot = this.pilots.find((p) => p.enabled && p.frequencyMhz === f);
            const thr = pilot ? pilot.enterThreshold : ch === 0 ? -58 : null;
            if (thr !== null && maxD >= thr - 12 && thr > maxD) {
              maxD = thr;
            }
          }
        }
        if (minD <= maxD) {
          let targetMin = Math.max(DBM_MIN, minD - 4);
          let targetMax = Math.min(DBM_MAX, maxD + 5);
          const minSpan = 16;
          if (targetMax - targetMin < minSpan) {
            const extra = minSpan - (targetMax - targetMin);
            targetMin = Math.max(DBM_MIN, targetMin - Math.floor(extra * 0.3));
            targetMax = Math.min(DBM_MAX, targetMin + minSpan);
          }
          if (this.signalSmoothYMin === null || this.signalSmoothYMax === null) {
            this.signalSmoothYMin = targetMin;
            this.signalSmoothYMax = targetMax;
          } else {
            const alphaMin = targetMin < this.signalSmoothYMin ? 0.6 : 0.14;
            const alphaMax = targetMax > this.signalSmoothYMax ? 0.65 : 0.14;
            this.signalSmoothYMin += (targetMin - this.signalSmoothYMin) * alphaMin;
            this.signalSmoothYMax += (targetMax - this.signalSmoothYMax) * alphaMax;
          }
          this.signalYMin = this.signalSmoothYMin;
          this.signalYMax = Math.max(this.signalYMin + 12, this.signalSmoothYMax);
        }
      }
    }
  }

  private updateAutoScanY(): void {
    if (!this.scanAutoY) return;
    const s = this.spectrumAcc.latest;
    if (!s || !s.dbm.length) return;
    const scanStop = s.start + s.step * (s.dbm.length - 1);
    const vStart = this.scanZoomStartMHz ?? s.start;
    const vStop = this.scanZoomStopMHz ?? scanStop;
    let minD = 1000;
    let maxD = -1000;
    const hold = this.scanShowMaxHold ? this.spectrumAcc.maxHold : null;
    for (let i = 0; i < s.dbm.length; i++) {
      const f = s.start + i * s.step;
      if (f < vStart || f > vStop) continue;
      const v = s.dbm[i];
      if (v < minD) minD = v;
      if (v > maxD) maxD = v;
      if (hold && hold[i] > maxD) maxD = hold[i];
    }
    if (minD <= maxD) {
      let targetMin = Math.max(DBM_MIN, minD - 4);
      let targetMax = Math.min(DBM_MAX, maxD + 6);
      if (targetMax - targetMin < 20) {
        targetMax = Math.min(DBM_MAX, targetMin + 20);
      }
      this.scanYMin = targetMin;
      this.scanYMax = targetMax;
      this.spectrumAcc.setColorRange(this.scanYMin, Math.min(-25, this.scanYMax + 6));
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
        const T = 12;
        const L = 44;
        const plotH = Math.max(10, r.height - T - 26);
        const plotW = Math.max(10, r.width - L - 14);
        if (x < 48) {
          // Dragging on left Y-axis stretches/shrinks the dBm scale smoothly
          const yFrac = Math.max(0, Math.min(1, 1 - (y - T) / plotH));
          this.signalDrag = {
            mode: "ystretch",
            startX: x,
            startY: y,
            startEndN: this.signalViewEndN(),
            startWindowSec: this.signalWindowSec,
            startYMin: this.signalYMin,
            startYMax: this.signalYMax,
            anchorFrac: yFrac,
          };
        } else if (y >= r.height - 26 && x >= L) {
          // Dragging on bottom X-axis stretches/shrinks the time window scale smoothly
          const xFrac = Math.max(0, Math.min(1, (x - L) / plotW));
          this.signalDrag = {
            mode: "xstretch",
            startX: x,
            startY: y,
            startEndN: this.signalViewEndN(),
            startWindowSec: this.signalWindowSec,
            startYMin: this.signalYMin,
            startYMax: this.signalYMax,
            anchorFrac: xFrac,
          };
        } else if (e.shiftKey) {
          this.signalDrag = {
            mode: "ybox",
            startX: x,
            startY: y,
            startEndN: this.signalViewEndN(),
            startWindowSec: this.signalWindowSec,
            startYMin: this.signalYMin,
            startYMax: this.signalYMax,
            anchorFrac: 0.5,
          };
          this.signalYZoomBox = { y0: y, y1: y };
        } else {
          // Normal drag inside plot pans both X (time) and Y (dBm)
          this.signalDrag = {
            mode: "pan",
            startX: x,
            startY: y,
            startEndN: this.signalViewEndN(),
            startWindowSec: this.signalWindowSec,
            startYMin: this.signalYMin,
            startYMax: this.signalYMax,
            anchorFrac: 0.5,
          };
        }
      } else if (target.matches("[data-spectrum-canvas]")) {
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const T = 12;
        const L = 44;
        const plotH = Math.max(10, r.height - T - 26);
        const plotW = Math.max(10, r.width - L - 14);
        const bounds = this.currentScanBounds();
        if (!bounds) return;
        if (x < 48) {
          const yFrac = Math.max(0, Math.min(1, 1 - (y - T) / plotH));
          this.specDragging = {
            mode: "ystretch",
            startX: x,
            startY: y,
            startYMin: this.scanYMin,
            startYMax: this.scanYMax,
            startMHz0: bounds.vStart,
            startMHz1: bounds.vStop,
            anchorFrac: yFrac,
          };
        } else if (y >= r.height - 26 && x >= L) {
          const xFrac = Math.max(0, Math.min(1, (x - L) / plotW));
          this.specDragging = {
            mode: "xstretch",
            startX: x,
            startY: y,
            startYMin: this.scanYMin,
            startYMax: this.scanYMax,
            startMHz0: bounds.vStart,
            startMHz1: bounds.vStop,
            anchorFrac: xFrac,
          };
        } else if (x >= L && x <= r.width - 14) {
          if (e.shiftKey) {
            this.specDragging = {
              mode: "zoom",
              startX: x,
              startY: y,
              startYMin: this.scanYMin,
              startYMax: this.scanYMax,
              startMHz0: bounds.vStart,
              startMHz1: bounds.vStop,
              anchorFrac: 0.5,
            };
            this.scanZoomBox = { x0: x, x1: x };
            this.dirtySpectrum = true;
          } else {
            // Normal drag inside Spectrum plot pans X (frequency MHz) and Y (dBm)
            this.specDragging = {
              mode: "pan",
              startX: x,
              startY: y,
              startYMin: this.scanYMin,
              startYMax: this.scanYMax,
              startMHz0: bounds.vStart,
              startMHz1: bounds.vStop,
              anchorFrac: 0.5,
            };
          }
        }
      } else if (target.matches("[data-waterfall-canvas]")) {
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const L = 44;
        const plotW = Math.max(10, r.width - L - 18);
        const bounds = this.currentScanBounds();
        if (x < 48 && this.spectrumAcc.history.length > 0) {
          // Dragging on Waterfall Y-axis stretches/shrinks vertical time scale (visibleRows)
          this.wfDragging = {
            mode: "ystretch",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
            startVisibleRows: this.spectrumAcc.visibleRows,
            startMHz0: bounds?.vStart ?? 5180,
            startMHz1: bounds?.vStop ?? 5917,
            anchorFrac: 0,
          };
        } else if (y >= r.height - 24 && x >= L && bounds) {
          // Dragging on Waterfall X-axis stretches/shrinks MHz span
          const xFrac = Math.max(0, Math.min(1, (x - L) / plotW));
          this.wfDragging = {
            mode: "xstretch",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
            startVisibleRows: this.spectrumAcc.visibleRows,
            startMHz0: bounds.vStart,
            startMHz1: bounds.vStop,
            anchorFrac: xFrac,
          };
        } else if (x >= r.width - 28 && this.spectrumAcc.maxScrollRow() > 0) {
          this.wfDragging = {
            mode: "scrollbar",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
            startVisibleRows: this.spectrumAcc.visibleRows,
            startMHz0: bounds?.vStart ?? 5180,
            startMHz1: bounds?.vStop ?? 5917,
            anchorFrac: 0,
          };
          scrubScrollbar(target, e.clientY);
        } else if (x >= L && x < r.width - 18) {
          if (e.shiftKey) {
            this.wfDragging = {
              mode: "zoom",
              startX: x,
              startY: e.clientY,
              startScroll: this.spectrumAcc.scrollRow,
              startVisibleRows: this.spectrumAcc.visibleRows,
              startMHz0: bounds?.vStart ?? 5180,
              startMHz1: bounds?.vStop ?? 5917,
              anchorFrac: 0.5,
            };
            this.scanZoomBox = { x0: x, x1: x };
            this.dirtyWaterfall = true;
            this.dirtySpectrum = true;
          } else {
            this.wfDragging = {
              mode: "pan",
              startX: x,
              startY: e.clientY,
              startScroll: this.spectrumAcc.scrollRow,
              startVisibleRows: this.spectrumAcc.visibleRows,
              startMHz0: bounds?.vStart ?? 5180,
              startMHz1: bounds?.vStop ?? 5917,
              anchorFrac: 0.5,
            };
          }
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
              const dHigh = this.signalYMin + (1 - (ya - T) / plotH) * span;
              const dLow = this.signalYMin + (1 - (yb - T) / plotH) * span;
              if (dHigh - dLow >= 4) {
                this.signalAutoY = false;
                this.signalYMin = Math.max(DBM_MIN, dLow);
                this.signalYMax = Math.min(DBM_MAX, dHigh);
                this.signalSmoothYMin = this.signalYMin;
                this.signalSmoothYMax = this.signalYMax;
              }
            }
          }
        }
        this.signalDrag = null;
        this.signalYZoomBox = null;
        this.renderSignalControls();
        this.dirtySignal = true;
      }

      if (this.specDragging) {
        const c = this.el.querySelector<HTMLElement>("[data-spectrum-canvas]");
        if (c && this.specDragging.mode === "zoom" && this.scanZoomBox) {
          const r = c.getBoundingClientRect();
          this.applyFreqZoomFromBox(this.scanZoomBox, Math.max(10, r.width - 44 - 14), 44);
        } else {
          this.renderScan();
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
        } else if (this.wfDragging.mode === "ystretch" || this.wfDragging.mode === "xstretch" || this.wfDragging.mode === "pan") {
          this.renderScan();
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
        this.signalAutoX = true;
        this.signalAutoY = true;
        this.signalSmoothYMin = null;
        this.signalSmoothYMax = null;
        this.renderSignalControls();
        this.dirtySignal = true;
        this.dirtyNoiseTable = true;
      } else if (target.matches("[data-spectrum-canvas], [data-waterfall-canvas]")) {
        this.scanZoomStartMHz = null;
        this.scanZoomStopMHz = null;
        this.scanAutoY = true;
        this.spectrumAcc.setVisibleRows(80);
        this.renderScan();
      }
    });

    this.listen(window, "mousemove", (e) => {
      const target = e.target as HTMLElement | null;
      if (this.signalDrag) {
        const sig = this.el.querySelector<HTMLElement>("[data-signal-canvas]");
        if (sig) {
          const r = sig.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const dx = x - this.signalDrag.startX;
          const dy = y - this.signalDrag.startY;
          const plotW = Math.max(10, r.width - 44 - 14);
          const plotH = Math.max(10, r.height - 12 - 26);
          if (this.signalDrag.mode === "ystretch") {
            // Dragging UP stretches Y (zooms in to smaller dBm span); dragging DOWN shrinks back to full span
            const factor = Math.exp(dy / 140);
            this.applyDbmStretch(this.signalDrag.startYMin, this.signalDrag.startYMax, this.signalDrag.anchorFrac, factor, "signal");
          } else if (this.signalDrag.mode === "xstretch") {
            // Dragging RIGHT stretches X (smaller windowSec so signals spread out); dragging LEFT shrinks X
            this.signalAutoX = false;
            const factor = Math.exp(-dx / 150);
            const nextSec = Math.max(0.4, Math.min(120, this.signalDrag.startWindowSec * factor));
            const sweepHz = this.status?.sweepHz ?? 50;
            const anchorN =
              this.signalDrag.startEndN - (1 - this.signalDrag.anchorFrac) * this.signalDrag.startWindowSec * sweepHz;
            this.signalWindowSec = nextSec;
            if (this.signalEndN !== null) {
              this.signalEndN = this.clampSignalEndN(anchorN + (1 - this.signalDrag.anchorFrac) * nextSec * sweepHz);
            }
            this.dirtySignal = true;
            this.dirtyNoiseTable = true;
          } else if (this.signalDrag.mode === "ybox") {
            this.signalYZoomBox = { y0: this.signalDrag.startY, y1: y };
            this.dirtySignal = true;
          } else if (this.signalDrag.mode === "pan") {
            if (Math.abs(dx) > 2) {
              const sweepHz = this.status?.sweepHz ?? 50;
              const windowSweeps = this.signalWindowSec * sweepHz;
              const deltaN = (dx / plotW) * windowSweeps;
              this.pauseSignalAt(this.signalDrag.startEndN - deltaN);
              this.dirtyNoiseTable = true;
            }
            if (Math.abs(dy) > 3 || !this.signalAutoY) {
              const ySpan = this.signalDrag.startYMax - this.signalDrag.startYMin;
              const deltaDbm = (dy / plotH) * ySpan;
              this.applyDbmPan(this.signalDrag.startYMin, this.signalDrag.startYMax, deltaDbm, "signal");
            }
            this.dirtySignal = true;
          }
        }
      }

      if (this.specDragging) {
        const spec = this.el.querySelector<HTMLElement>("[data-spectrum-canvas]");
        if (spec) {
          const r = spec.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const dx = x - this.specDragging.startX;
          const dy = y - this.specDragging.startY;
          const plotW = Math.max(10, r.width - 44 - 14);
          const plotH = Math.max(10, r.height - 12 - 26);
          if (this.specDragging.mode === "ystretch") {
            const factor = Math.exp(dy / 140);
            this.applyDbmStretch(this.specDragging.startYMin, this.specDragging.startYMax, this.specDragging.anchorFrac, factor, "scan");
          } else if (this.specDragging.mode === "xstretch") {
            const factor = Math.exp(-dx / 150);
            this.applyFreqStretch(this.specDragging.startMHz0, this.specDragging.startMHz1, this.specDragging.anchorFrac, factor);
          } else if (this.specDragging.mode === "zoom") {
            const clampedX = Math.max(44, Math.min(r.width - 14, x));
            this.scanZoomBox = { x0: this.specDragging.startX, x1: clampedX };
            this.dirtySpectrum = true;
          } else if (this.specDragging.mode === "pan") {
            if (Math.abs(dx) > 2) {
              const fSpan = this.specDragging.startMHz1 - this.specDragging.startMHz0;
              const deltaMHz = -(dx / plotW) * fSpan;
              this.applyFreqPan(this.specDragging.startMHz0, this.specDragging.startMHz1, deltaMHz);
            }
            if (Math.abs(dy) > 2 || !this.scanAutoY) {
              const ySpan = this.specDragging.startYMax - this.specDragging.startYMin;
              const deltaDbm = (dy / plotH) * ySpan;
              this.applyDbmPan(this.specDragging.startYMin, this.specDragging.startYMax, deltaDbm, "scan");
            }
          }
        }
      }

      if (this.wfDragging) {
        const wf = this.el.querySelector<HTMLElement>("[data-waterfall-canvas]");
        if (wf) {
          const r = wf.getBoundingClientRect();
          const x = e.clientX - r.left;
          const dx = x - this.wfDragging.startX;
          const dy = e.clientY - this.wfDragging.startY;
          const plotW = Math.max(10, r.width - 44 - 18);
          if (this.wfDragging.mode === "ystretch") {
            // Dragging UP stretches rows (fewer visible passes = taller rows); dragging DOWN compresses more passes
            const factor = Math.exp(dy / 140);
            this.spectrumAcc.setVisibleRows(this.wfDragging.startVisibleRows * factor);
            this.updateScanFindings();
            this.dirtyWaterfall = true;
          } else if (this.wfDragging.mode === "xstretch") {
            const factor = Math.exp(-dx / 150);
            this.applyFreqStretch(this.wfDragging.startMHz0, this.wfDragging.startMHz1, this.wfDragging.anchorFrac, factor);
          } else if (this.wfDragging.mode === "scrollbar") {
            scrubScrollbar(wf, e.clientY);
          } else if (this.wfDragging.mode === "zoom") {
            const clampedX = Math.max(44, Math.min(r.width - 18, x));
            this.scanZoomBox = { x0: this.wfDragging.startX, x1: clampedX };
            this.dirtyWaterfall = true;
            this.dirtySpectrum = true;
          } else if (this.wfDragging.mode === "pan") {
            if (Math.abs(dx) > 2) {
              const fSpan = this.wfDragging.startMHz1 - this.wfDragging.startMHz0;
              const deltaMHz = -(dx / plotW) * fSpan;
              this.applyFreqPan(this.wfDragging.startMHz0, this.wfDragging.startMHz1, deltaMHz);
            }
            const pxPerRow = Math.max(1, (r.height - 30) / this.spectrumAcc.visibleRows);
            const deltaRows = (this.wfDragging.startY - e.clientY) / pxPerRow;
            this.spectrumAcc.setScrollRow(this.wfDragging.startScroll + deltaRows);
            this.updateScanFindings();
            this.dirtyWaterfall = true;
          }
        }
      }

      if (target && target.matches && target.matches("[data-signal-canvas], [data-spectrum-canvas], [data-waterfall-canvas]")) {
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const isDraggingPlot =
          (this.signalDrag && this.signalDrag.mode === "pan") ||
          (this.specDragging && this.specDragging.mode === "pan") ||
          (this.wfDragging && this.wfDragging.mode === "pan");
        if (isDraggingPlot) {
          target.style.cursor = "grabbing";
        } else if (x < 48 || (target.matches("[data-waterfall-canvas]") && x >= r.width - 28)) {
          target.style.cursor = "ns-resize";
        } else if (y >= r.height - 26 && x >= 44) {
          target.style.cursor = "ew-resize";
        } else if (e.shiftKey) {
          target.style.cursor = "crosshair";
        } else {
          target.style.cursor = "grab";
        }
        if (target.matches("[data-signal-canvas]")) {
          this.signalHover = { x, y };
          this.dirtySignal = true;
        } else if (target.matches("[data-spectrum-canvas]")) {
          this.scanHover = { x, y };
          this.dirtySpectrum = true;
        } else if (target.matches("[data-waterfall-canvas]")) {
          this.waterfallHover = { x, y };
          this.dirtyWaterfall = true;
        }
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
          const factor = e.deltaY > 0 ? 1.18 : 0.84;
          // Wheel on Y-axis (< 48px) or Shift+Wheel zooms the Y-axis (dBm) around cursor Y
          if (x < 48 || e.shiftKey) {
            const T = 12;
            const plotH = Math.max(10, r.height - T - 26);
            const yFrac = Math.max(0, Math.min(1, 1 - (y - T) / plotH));
            this.applyDbmStretch(this.signalYMin, this.signalYMax, yFrac, factor, "signal");
            this.renderSignalControls();
          } else {
            // Wheel on plot or X-axis zooms the time window (0.4 s .. 120 s) around cursor X
            this.signalAutoX = false;
            const L = 44;
            const plotW = Math.max(10, r.width - L - 14);
            const sweepHz = this.status?.sweepHz ?? 50;
            const frac = Math.max(0, Math.min(1, (x - L) / plotW));
            const curEndN = this.signalViewEndN();
            const curSweeps = this.signalWindowSec * sweepHz;
            const anchorN = curEndN - (1 - frac) * curSweeps;
            const nextSec = Math.max(0.4, Math.min(120, this.signalWindowSec * factor));
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
        if (target.matches("[data-spectrum-canvas]")) {
          e.preventDefault();
          const r = target.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const factor = e.deltaY > 0 ? 1.18 : 0.84;
          if (x < 48 || e.shiftKey) {
            const T = 12;
            const plotH = Math.max(10, r.height - T - 26);
            const yFrac = Math.max(0, Math.min(1, 1 - (y - T) / plotH));
            this.applyDbmStretch(this.scanYMin, this.scanYMax, yFrac, factor, "scan");
            this.renderScan();
          } else {
            const bounds = this.currentScanBounds();
            if (bounds) {
              const plotW = Math.max(10, r.width - 44 - 14);
              const xFrac = Math.max(0, Math.min(1, (x - 44) / plotW));
              this.applyFreqStretch(bounds.vStart, bounds.vStop, xFrac, factor);
              this.renderScan();
            }
          }
          return;
        }
        if (!target.matches("[data-waterfall-canvas]")) return;
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const factor = e.deltaY > 0 ? 1.18 : 0.84;
        if (x < 48 || e.shiftKey) {
          e.preventDefault();
          this.spectrumAcc.setVisibleRows(this.spectrumAcc.visibleRows * factor);
          this.renderScan();
          return;
        }
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
        this.updateAutoSignalAxes(c.clientWidth || 700);
        drawSignalOverTimeCanvas(c, this.signalRing, {
          windowSec: this.signalWindowSec,
          sweepHz: this.status?.sweepHz ?? 50,
          endN: this.signalEndN,
          refN: this.signalRefN,
          yMinDbm: this.signalYMin,
          yMaxDbm: this.signalYMax,
          autoX: this.signalAutoX,
          autoY: this.signalAutoY,
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
        this.updateAutoScanY();
        drawSpectrumCanvas(c, this.spectrumAcc, {
          showMaxHold: this.scanShowMaxHold,
          showAverage: this.scanShowAvg,
          showWifiOverlay: this.scanShowWifi,
          viewStartMHz: this.scanZoomStartMHz,
          viewStopMHz: this.scanZoomStopMHz,
          yMinDbm: this.scanYMin,
          yMaxDbm: this.scanYMax,
          autoY: this.scanAutoY,
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
      const grid = this.el.querySelector<HTMLElement>("[data-health-grid]");
      if (grid) {
        drawHealthSparklines(grid, this.healthHistory, this.hasServer);
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
          this.signalFindings = [];
          this.signalFindingSeq = 0;
          this.scanFindings = [];
          this.scanFindingSeq = 0;
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
          if (this.scanLive || this.status?.scanLive) {
            this.scanToggleAt = Date.now();
            this.scanLive = false;
            if (this.status) this.status.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
            this.liveOn = true;
            this.signalEndN = null;
            await this.console.send(`LIVE ${this.liveMode}`);
            this.renderScan();
            this.renderChannels();
          } else {
            this.liveOn = !this.liveOn;
            if (this.liveOn) {
              this.signalEndN = null;
            } else if (this.signalEndN === null && this.signalRing.points.length > 0) {
              this.pauseSignalAt(this.signalRing.latestN());
            }
            await this.console.send(this.liveOn ? `LIVE ${this.liveMode}` : "LIVE 0");
          }
          this.renderLiveHead();
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "rf": {
          const on = !(this.status?.rf.enabled ?? true);
          if (!on && !confirm("Switch the 5.8 GHz receiver off? The timer stops timing until you switch it back on or restart it.")) break;
          await this.console.request(`RF ${on ? 1 : 0}`, "ok", 2000);
          await this.refreshStatus();
          this.renderLiveHead();
          this.renderSignalControls();
          this.renderScan();
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
        case "signal-auto-x":
          this.signalAutoX = true;
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "signal-window": {
          const w = Number(t.dataset.win);
          if (w > 0 && w <= 120) {
            this.signalAutoX = false;
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
          if (this.scanLive || this.status?.scanLive) {
            this.scanToggleAt = Date.now();
            this.scanLive = false;
            if (this.status) this.status.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
            this.liveOn = true;
            this.signalEndN = null;
            await this.console.send(`LIVE ${this.liveMode}`);
            this.renderScan();
            this.renderLiveHead();
            this.renderChannels();
          } else if (!this.liveOn && this.console.connected) {
            this.liveOn = true;
            this.signalEndN = null;
            await this.console.send(`LIVE ${this.liveMode}`);
            this.renderLiveHead();
          } else if (this.signalEndN === null) {
            this.liveOn = false;
            this.pauseSignalAt(this.signalRing.latestN());
            if (this.console.connected) {
              await this.console.send("LIVE 0");
            }
            this.renderLiveHead();
          } else {
            this.signalEndN = null;
          }
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "signal-auto-y":
          this.signalAutoY = !this.signalAutoY;
          if (!this.signalAutoY) {
            this.signalYMin = DBM_MIN;
            this.signalYMax = DBM_MAX;
          } else {
            this.signalSmoothYMin = null;
            this.signalSmoothYMax = null;
          }
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-reset-y":
          this.signalAutoY = true;
          this.signalSmoothYMin = null;
          this.signalSmoothYMax = null;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-reset-x":
          this.signalAutoX = true;
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
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
          this.signalFindings = [];
          this.signalFindingSeq = 0;
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "clear-signal-findings":
          this.signalFindings = [];
          this.signalFindingSeq = 0;
          this.renderNoiseTable();
          break;
        case "clear-scan-findings":
          this.scanFindings = [];
          this.scanFindingSeq = 0;
          this.updateScanFindings();
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
            if (this.status) this.status.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
            if (this.liveOn) {
              this.liveOn = false;
              await this.console.send("LIVE 0").catch(() => undefined);
            }
          } else {
            const start = this.num("[data-scan-start]", 5180);
            const stop = this.num("[data-scan-stop]", 5917);
            const step = this.num("[data-scan-step]", 5);
            this.spectrumAcc.clearHoldAndAvg();
            await this.console.request(`SCAN LIVE ${start} ${stop} ${step}`, "ok", 2000);
            this.scanLive = true;
            if (this.status) this.status.scanLive = true;
          }
          this.renderScan();
          this.renderLiveHead();
          this.renderSignalControls();
          this.renderChannels();
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
        case "wf-reset-rows":
          this.spectrumAcc.setVisibleRows(80);
          this.renderScan();
          break;
        case "scan-reset-zoom":
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          this.renderScan();
          break;
        case "scan-reset-y":
          this.scanAutoY = true;
          this.renderScan();
          break;
        case "scan-auto-y":
          this.scanAutoY = !this.scanAutoY;
          if (!this.scanAutoY) {
            this.scanYMin = DBM_MIN;
            this.scanYMax = DBM_MAX;
            this.spectrumAcc.setColorRange(-100, -40);
          }
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
    const on = this.console.connected;
    const s = this.status;
    const profile = s ? FIRMWARE_PROFILES.find((p) => p.code === s.profile) : undefined;
    const budget = s ? s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0) : 0;
    const badReset = s ? BAD_RESETS.includes(s.reset) : false;
    const unprov = s ? s.fp.toUpperCase() === UNPROVISIONED_FP : false;
    const ledClass = on && s ? "is-up" : on ? "is-warn" : "";
    const headText = s
      ? `On · polling every 2 s · up ${fmtUptime(s.uptimeMs)}`
      : on
        ? "Waiting for timer status…"
        : "Off · connect a timer over USB";

    const rfBadge = !s
      ? `<span class="badge">—</span>`
      : !s.rf.ok
        ? `<span class="badge badge-bad">Boot check failed</span>`
        : !s.rf.enabled
          ? `<span class="badge badge-warn">Switched off</span>`
          : s.scanLive
            ? `<span class="badge badge-accent">Live scan</span>`
            : `<span class="badge badge-good">OK</span>`;

    const freqs = s?.freqs ?? RACEBAND;
    const chChips = freqs
      .map((f, i) => {
        const rb = racebandName(f) || `Ch${i + 1}`;
        return `<span class="debug-status-ch mono"><strong>${rb}</strong> ${f}</span>`;
      })
      .join("");

    this.slot("status").innerHTML = `
      <div class="debug-card-head">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="note debug-head-note mono">${headText}</span>
        </span>
        <div class="debug-connect-actions">
          ${
            s
              ? `<span class="badge ${s.role === 1 ? "badge-accent" : ""}">${s.role === 1 ? "Hub" : `Spoke${s.slot ? ` · Slot ${s.slot}` : ""}`}</span>
                 <span class="badge mono">${esc(s.fw)}</span>
                 <span class="badge ${badReset ? "badge-bad" : ""}">Boot #${s.boots ?? "?"} · ${esc(s.reset)}</span>`
              : `<span class="badge">Disconnected</span>`
          }
        </div>
      </div>
      <div class="debug-status-panels">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title">${icons.cpu(14)}<span>Identity &amp; hardware</span></span>
            <span class="badge ${unprov ? "badge-warn" : "mono"}">${s ? (unprov ? `${esc(s.fp)} · not set up` : esc(s.fp)) : "—"}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Timer</dt>
              <dd>${s ? `${esc(s.label || "(unnamed)")} <span class="note">· ${s.role === 1 ? "Hub" : `Spoke${s.slot ? ` · slot ${s.slot}` : ""}`}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware</dt>
              <dd>${s ? `${esc(profile?.name ?? `profile ${s.profile}`)} <span class="note mono">· ${esc(s.fw)}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Chip &amp; flash</dt>
              <dd>${s?.chip ? `${esc(s.chip.model)} ${esc(s.chip.rev)} <span class="note">· ${s.chip.flashMB} MB</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>MAC address</dt>
              <dd>${s?.chip ? `<span class="mono">${esc(s.chip.mac)}</span>` : "—"}</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title">${icons.signal(14)}<span>5.8 GHz receiver</span></span>
            ${rfBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Noise floor</dt>
              <dd>${s ? `${s.rf.floorDb.toFixed(1)} dBm <span class="note">· gain ${s.rf.gain}/${s.rf.gainMax}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Sweep timing</dt>
              <dd>${
                s
                  ? `${s.sweepHz} Hz · ${(s.sweepUs / 1000).toFixed(2)} ms <span class="note">(max <span class="${budget && s.sweepUsMax > budget ? "debug-tone-warn" : ""}">${(s.sweepUsMax / 1000).toFixed(2)} ms</span> / ${(budget / 1000).toFixed(1)} ms)</span>`
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
            <span class="debug-subbox-title">${icons.wifi(14)}<span>System &amp; network</span></span>
            <span class="badge">${s ? (s.net ? `${esc(s.net.mode)} · Ch ${s.channel}` : `Ch ${s.channel}`) : "—"}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Uptime</dt>
              <dd>${s ? `${fmtUptime(s.uptimeMs)} <span class="note">· boot #${s.boots ?? "?"}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Last restart</dt>
              <dd>${s ? (badReset ? `<span class="tone-bad">${esc(s.reset)}</span> <span class="note">— see boot log</span>` : esc(s.reset)) : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Memory free</dt>
              <dd>${s ? `${(s.heapFree / 1024).toFixed(0)} KB <span class="note">· lowest ${(s.heapMin / 1024).toFixed(0)} KB</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Wi-Fi link</dt>
              <dd>${
                s
                  ? s.net
                    ? s.role === 1
                      ? `${s.net.stations} device${s.net.stations === 1 ? "" : "s"} joined`
                      : s.slot >= 2
                        ? `Joined Hub · slot ${s.slot}`
                        : "Not joined to a Hub"
                    : `Channel ${s.channel}`
                  : "—"
              }</dd>
            </div>
          </dl>
        </div>
      </div>`;
  }

  private renderLiveHead(): void {
    const on = this.console.connected;
    const rfOn = this.status?.rf.enabled ?? true;
    const inScanMode = Boolean(this.scanLive || this.status?.scanLive);
    const streamDisabled = !on || !rfOn;
    const streamActive = !streamDisabled && !inScanMode && this.liveOn;
    const streamLabel = streamActive ? "Pause" : "Stream";
    const streamTitle = !rfOn
      ? "Unavailable while the 5.8 GHz receiver is switched off"
      : !on
        ? "Connect a timer to stream live 5.8 GHz readings"
        : streamActive
          ? "Streaming live 5.8 GHz readings — click to pause"
          : inScanMode
            ? "Paused while Spectrum scan is streaming — click to pause Spectrum scan and stream 5.8 GHz channels"
            : "Paused — click to stream live 5.8 GHz readings";
    const ledClass = streamActive ? "is-up" : on && (inScanMode || !rfOn) ? "is-warn" : "";
    this.slot("live-head").innerHTML = `
      <div class="debug-card-head">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}" data-live-led></span>
          <span class="note debug-head-note mono" data-live-note>${on ? "Waiting for sweep stream…" : "Paused · not connected"}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm ${rfOn ? "btn-armed" : "btn-unarmed"}" data-action="rf" ${on && this.status && !inScanMode ? "" : "disabled"} title="${inScanMode ? "Pause Spectrum scan first to toggle the 5.8 GHz receiver" : "Switch the hardware 5.8 GHz receiver on or off"}">
            ${rfOn ? icons.signal(14) : icons.signalOff(14)}<span>${rfOn ? "Receiver on" : "Receiver off"}</span>
          </button>
          <button type="button" class="btn btn-sm ${streamActive ? "btn-armed" : "btn-unarmed"}" data-action="live" ${streamDisabled ? "disabled" : ""} title="${streamTitle}">
            ${streamActive ? icons.pause(14) : icons.play(14)}<span>${streamLabel}</span>
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
    const led = this.el.querySelector<HTMLElement>("[data-live-led]");
    const on = this.console.connected;
    const rfOn = this.status?.rf.enabled ?? true;
    const inScanMode = Boolean(this.scanLive || this.status?.scanLive);
    if (led) {
      led.classList.toggle("is-up", on && rfOn && !inScanMode && this.liveOn);
      led.classList.toggle("is-warn", on && (inScanMode || !rfOn));
    }
    if (note) {
      if (!on) {
        note.textContent = "Paused · not connected";
      } else if (inScanMode) {
        note.textContent = "Paused · Spectrum scan is streaming";
      } else if (this.status && !this.status.rf.enabled) {
        note.textContent = "Off · 5.8 GHz receiver is switched off";
      } else if (!this.liveOn) {
        note.textContent = "Paused";
      } else if (l) {
        note.textContent = `Streaming · ${this.liveMode === 2 ? "50 Hz (every sweep)" : "10 Hz"} · sweep ${(l.us / 1000).toFixed(2)} ms`;
      } else {
        note.textContent = "Streaming · waiting for sweeps…";
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
    const inScanMode = Boolean(this.scanLive || s?.scanLive);
    const freqs = s?.freqs ?? RACEBAND;
    const isTemp = Boolean(s?.freqsTemporary);
    this.slot("channels").innerHTML = `
      <div class="debug-channels">
        <div class="debug-channels-head">
          <div class="debug-channels-title">
            <strong>Try other channels</strong>
            <span class="badge ${isTemp ? "badge-accent" : ""}">${isTemp ? "Temporary · not saved" : "Saved channels"}</span>
          </div>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-action="channels-raceband" ${on && !inScanMode ? "" : "disabled"}>Load Raceband</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="channels-reset" ${on && isTemp && !inScanMode ? "" : "disabled"}>Back to saved</button>
            <button type="button" class="btn btn-sm btn-armed" data-action="channels-apply" ${on && s && !inScanMode ? "" : "disabled"} title="${inScanMode ? "Unavailable while Live spectrum scan is running" : "Apply these 8 channels temporarily until the timer restarts"}">Apply until restart</button>
          </div>
        </div>
        <div class="debug-channels-inputs">
          ${freqs
            .map((f, i) => {
              const rb = racebandName(f) || `Ch ${i + 1}`;
              return `<label><span class="note mono">${rb}</span><input class="input mono" type="number" min="5180" max="5917" data-chan value="${f}" ${on && !inScanMode ? "" : "disabled"}/></label>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  private renderSignalControls(): void {
    const on = this.console.connected;
    const rfOn = this.status?.rf.enabled ?? true;
    const inScanMode = Boolean(this.scanLive || this.status?.scanLive);
    const streamRunning = on && rfOn && this.liveOn && !inScanMode;
    const freqs = this.status?.freqs ?? RACEBAND;
    const hasPts = this.signalRing.points.length > 0;
    const allOn = this.signalEnabledCh.every(Boolean);
    const isLive = this.signalEndN === null;
    const liveFollowOn = isLive && streamRunning;
    const liveDisabled = (!on || !rfOn) && !hasPts;
    const isYZoomed = this.signalYMin !== DBM_MIN || this.signalYMax !== DBM_MAX;
    const liveLabel = liveFollowOn ? "Pause" : "Stream";
    const liveTitle = !rfOn
      ? "Unavailable while the 5.8 GHz receiver is switched off"
      : !on
        ? "Connect a timer to stream live 50 Hz sweeps"
        : liveFollowOn
          ? "Streaming 50 Hz sweeps — click to pause, or drag the chart to scroll back"
          : inScanMode
            ? "Paused while Spectrum scan is streaming — click to pause Spectrum scan and stream 50 Hz sweeps"
            : "Paused — click to stream live 50 Hz sweeps";
    const presets = [1, 2, 5, 10, 30, 120] as const;
    const isCustomWindow = !this.signalAutoX && !presets.some((w) => Math.abs(this.signalWindowSec - w) < 0.05);
    const sigLedClass = liveFollowOn ? "is-up" : (streamRunning && !isLive) || (on && inScanMode) ? "is-warn" : "";
    const sigStatusText = liveFollowOn
      ? `Streaming · ${this.liveMode === 2 ? "50 Hz" : "10 Hz"}`
      : streamRunning && !isLive
        ? "Paused · scrolled back"
        : inScanMode
          ? "Paused · scan active"
          : "Paused";
    this.slot("signal-controls").innerHTML = `
      <div class="debug-card-head">
        <div class="debug-toolbar-left">
          <span class="debug-led-status" title="${liveTitle}">
            <span class="status-dot ${sigLedClass}"></span>
            <span class="note mono">${sigStatusText}</span>
          </span>
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
          <button type="button" class="btn btn-sm btn-ghost" data-action="signal-clear" ${hasPts ? "" : "disabled"}>Clear</button>
          <button type="button" class="btn btn-sm ${liveFollowOn ? "btn-armed" : "btn-unarmed"}" data-action="signal-freeze" ${liveDisabled ? "disabled" : ""} title="${liveTitle}">
            ${liveFollowOn ? icons.pause(14) : icons.play(14)}<span>${liveLabel}</span>
          </button>
        </div>
      </div>
      <div class="debug-subbar debug-chart-axisbar">
        <span class="note debug-chart-hint">${liveFollowOn ? "Drag chart to pan X/Y · drag axes to stretch · wheel to zoom" : "Paused · drag chart to pan X/Y · double-click to reset"}</span>
        <div class="debug-connect-actions">
          <div class="segmented" role="group" aria-label="Time window">
            <button type="button" class="${this.signalAutoX ? "is-active" : ""}" data-action="signal-auto-x" title="Automatically adjust X-axis time window based on incoming sample rate">Auto X</button>
            ${presets
              .map(
                (w) =>
                  `<button type="button" class="${!this.signalAutoX && Math.abs(this.signalWindowSec - w) < 0.05 ? "is-active" : ""}" data-action="signal-window" data-win="${w}" title="Set X-axis time window to ${w === 120 ? "2 minutes" : `${w} seconds`} (or drag horizontally on the X-axis)">${w === 120 ? "2 min" : `${w} s`}</button>`
              )
              .join("")}
          </div>
          ${
            isCustomWindow
              ? `<button type="button" class="btn btn-sm btn-armed mono" data-action="signal-reset-x" title="Reset X-axis time window to Auto">${icons.target(13)}<span>X: ${this.signalWindowSec < 10 ? this.signalWindowSec.toFixed(1) : Math.round(this.signalWindowSec)} s ×</span></button>`
              : ""
          }
          <button type="button" class="btn btn-sm ${this.signalAutoY ? "btn-armed" : "btn-unarmed"} mono" data-action="signal-auto-y" title="${this.signalAutoY ? "Auto Y-axis scaling is ON — fits visible signal traces automatically. Click for full manual scale (-100…-20 dBm), or drag the Y-axis to stretch." : "Manual Y-axis range — click to re-enable Auto Y-axis scaling"}">
            ${icons.target(13)}<span>${this.signalAutoY ? "Auto Y" : `Y: ${Math.round(this.signalYMin)}…${Math.round(this.signalYMax)} dBm`}</span>
          </button>
          ${
            !this.signalAutoY && isYZoomed
              ? `<button type="button" class="btn btn-sm btn-ghost" data-action="signal-reset-y" title="Set Y-axis dBm scale to full range (${DBM_MIN}…${DBM_MAX} dBm)">Full Y</button>`
              : !this.signalAutoY
                ? `<button type="button" class="btn btn-sm btn-ghost" data-action="signal-zoom-floor" title="Zoom Y-axis into the noise floor region (−102…−68 dBm), or drag vertically on the Y-axis">Zoom floor Y</button>`
                : ""
          }
        </div>
      </div>`;
    this.slot("signal-legend").innerHTML = `
      <div class="debug-chart-legend">
        <div class="debug-channel-chips" role="group" aria-label="Channel trace legend">
          ${freqs
            .map((f, i) => {
              const rb = racebandName(f) || `Ch${i + 1}`;
              const chOn = this.signalEnabledCh[i];
              const col = CHANNEL_COLORS[i];
              return `<button type="button" class="debug-ch-chip mono ${chOn ? "is-on" : ""}" data-action="signal-ch" data-ch="${i}" style="--ch-color:${col}">
                <span class="debug-ch-dot"></span><strong>${rb}</strong> <span>${f}</span>
              </button>`;
            })
            .join("")}
          <button type="button" class="btn btn-sm btn-ghost debug-ch-all-btn" data-action="signal-ch-all">${allOn ? "Hide all" : "Show all"}</button>
        </div>
        <div class="debug-connect-actions">
          <div class="debug-btn-group" role="group" aria-label="Export signal chart">
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-csv" ${hasPts ? "" : "disabled"} title="Download recorded 50 Hz samples as CSV">CSV</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-png" ${hasPts ? "" : "disabled"} title="Save chart snapshot as PNG">PNG</button>
          </div>
        </div>
      </div>`;
  }

  private recordSignalFindingFromSample(s: LiveSample): void {
    const now = Date.now();
    const freqs = this.status?.freqs ?? RACEBAND;
    for (let i = 0; i < 8; i++) {
      const f = freqs[i] ?? RACEBAND[i];
      const rb = racebandName(f) || `Ch${i + 1}`;
      const col = CHANNEL_COLORS[i];
      const pilot = this.pilots.find((p) => Math.abs(p.frequencyMHz - f) <= 2);
      const enterThr = pilot ? pilot.enterThreshold : -65;
      const pilotLabel = pilot?.callsign ? `${pilot.callsign} (${enterThr} dBm)` : `${enterThr} dBm`;
      const floor = s.floor[i] !== undefined && s.floor[i] > -127 ? s.floor[i] : -95;
      const v = Math.max(s.dbm[i] ?? -127, s.pk[i] ?? -127);
      const hits = s.hits?.[i] ?? 0;

      if (v >= enterThr) {
        const key = `trig:${i}`;
        const existing = this.signalFindings.find((e) => e.key === key && now - e.lastMs <= 4000);
        if (existing) {
          existing.lastMs = now;
          existing.maxDbm = Math.max(existing.maxDbm, v);
          existing.count++;
          const durSec = (existing.lastMs - existing.firstMs) / 1000;
          existing.detail = `Peak ${existing.maxDbm} dBm reached enter threshold ${pilotLabel} (+${existing.maxDbm - enterThr} dB) · ${existing.count} sweeps${durSec >= 0.2 ? ` over ${durSec.toFixed(1)} s` : ""}`;
        } else {
          this.signalFindings.unshift({
            id: ++this.signalFindingSeq,
            key,
            firstMs: now,
            lastMs: now,
            timeLabel: fmtWallTimeMs(now),
            tone: "badge-warn",
            badge: "Enter thr",
            sourceLabel: `${rb} · ${f} MHz`,
            sourceColor: col,
            maxDbm: v,
            count: 1,
            detail: `Peak ${v} dBm reached enter threshold ${pilotLabel} (+${v - enterThr} dB)`,
          });
        }
      } else if (v >= floor + 10 || hits > 0) {
        const key = `burst:${i}`;
        const existing = this.signalFindings.find((e) => e.key === key && now - e.lastMs <= 4000);
        if (existing) {
          existing.lastMs = now;
          existing.maxDbm = Math.max(existing.maxDbm, v);
          existing.count += Math.max(1, hits);
          const durSec = (existing.lastMs - existing.firstMs) / 1000;
          existing.detail = `Burst to ${existing.maxDbm} dBm (+${existing.maxDbm - floor} dB above ${floor} dBm floor, ${enterThr - existing.maxDbm} dB below enter) · ${existing.count} hits${durSec >= 0.2 ? ` over ${durSec.toFixed(1)} s` : ""}`;
        } else {
          this.signalFindings.unshift({
            id: ++this.signalFindingSeq,
            key,
            firstMs: now,
            lastMs: now,
            timeLabel: fmtWallTimeMs(now),
            tone: "badge-accent",
            badge: "RF burst",
            sourceLabel: `${rb} · ${f} MHz`,
            sourceColor: col,
            maxDbm: v,
            count: Math.max(1, hits),
            detail: `Burst to ${v} dBm (+${v - floor} dB above ${floor} dBm floor, ${enterThr - v} dB below enter — will not trigger a lap)`,
          });
        }
      }
    }

    if (this.signalFindings.length === 0 && this.signalRing.points.length >= 25) {
      const validFloors = s.floor.filter((fl) => fl > -127);
      const minFl = validFloors.length ? Math.min(...validFloors) : -95;
      const maxFl = validFloors.length ? Math.max(...validFloors) : -93;
      this.signalFindings.unshift({
        id: ++this.signalFindingSeq,
        key: "baseline",
        firstMs: now,
        lastMs: now,
        timeLabel: fmtWallTimeMs(now),
        tone: "badge-good",
        badge: "Quiet",
        sourceLabel: "All 8 channels",
        maxDbm: maxFl,
        count: this.signalRing.points.length,
        detail: `Background noise floor steady at ${minFl}…${maxFl} dBm across all 8 channels (≥ 25 dB headroom below pilot enter thresholds).`,
      });
    }

    if (this.signalFindings.length > 100) {
      this.signalFindings.length = 100;
    }
  }

  private recordScanFindingFromPass(s: ScanResult): void {
    const now = Date.now();
    const peaks = this.spectrumAcc.topPeaks(5);
    const sorted = [...s.dbm].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -95;
    const scanStop = s.start + s.step * Math.max(0, s.dbm.length - 1);

    if (peaks.length > 0) {
      for (const p of peaks) {
        const binMHz = Math.round(p.freqMHz / 10) * 10;
        const key = `peak:${binMHz}`;
        const existing = this.scanFindings.find((e) => e.key === key && now - e.lastMs <= 6000);
        if (existing) {
          existing.lastMs = now;
          existing.maxDbm = Math.max(existing.maxDbm, p.dbm);
          existing.count++;
          existing.tone = existing.maxDbm >= -65 ? "badge-warn" : "badge-accent";
          existing.badge = existing.maxDbm >= -65 ? "Strong peak" : "RF peak";
          existing.sourceLabel = `${p.freqMHz} MHz · ${p.bandHint}`;
          existing.detail = `Peak ${existing.maxDbm} dBm (+${existing.maxDbm - median} dB above ${median} dBm median) · seen across ${existing.count} scan passes`;
        } else {
          this.scanFindings.unshift({
            id: ++this.scanFindingSeq,
            key,
            firstMs: now,
            lastMs: now,
            timeLabel: fmtWallTimeMs(now),
            tone: p.dbm >= -65 ? "badge-warn" : "badge-accent",
            badge: p.dbm >= -65 ? "Strong peak" : "RF peak",
            sourceLabel: `${p.freqMHz} MHz · ${p.bandHint}`,
            maxDbm: p.dbm,
            count: 1,
            detail: `Peak ${p.dbm} dBm (+${p.dbm - median} dB above ${median} dBm band median)`,
          });
        }
      }
    } else if (!s.live || this.scanFindings.length === 0) {
      const existingQuiet = this.scanFindings.find((e) => e.key === "quiet" && now - e.lastMs <= 10000);
      if (existingQuiet) {
        existingQuiet.lastMs = now;
        existingQuiet.count++;
        existingQuiet.detail = `No peaks ≥ 6 dB above the ${median} dBm band median (${s.dbm.length} points, ${existingQuiet.count} passes).`;
      } else {
        this.scanFindings.unshift({
          id: ++this.scanFindingSeq,
          key: "quiet",
          firstMs: now,
          lastMs: now,
          timeLabel: fmtWallTimeMs(now),
          tone: "badge-good",
          badge: "Quiet band",
          sourceLabel: `${s.start}–${scanStop} MHz`,
          maxDbm: median,
          count: 1,
          detail: `No peaks ≥ 6 dB above the ${median} dBm band median across ${s.dbm.length} points.`,
        });
      }
    }

    if (this.scanFindings.length > 100) {
      this.scanFindings.length = 100;
    }
  }

  private renderFindingsLogHtml(
    entries: FindingLogEntry[],
    clearAction: "clear-signal-findings" | "clear-scan-findings",
    emptyHint: string
  ): string {
    return `
      <div class="debug-findings-head">
        <div class="debug-findings-title-group">
          <span class="debug-findings-title">Findings log</span>
          <span class="badge mono">${entries.length}</span>
          <span class="note debug-findings-sub">Newest first · coalesces ongoing bursts on the same channel</span>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-action="${clearAction}" ${entries.length ? "" : "disabled"}>Clear</button>
      </div>
      <div class="debug-findings-scroll" data-findings-scroll>
        ${
          entries.length === 0
            ? `<div class="debug-findings-empty note">${esc(emptyHint)}</div>`
            : `<table class="debug-findings-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Channel / Freq</th>
                    <th>Finding</th>
                  </tr>
                </thead>
                <tbody>
                  ${entries
                    .map(
                      (e) => `<tr>
                        <td class="mono note">#${e.id}</td>
                        <td class="mono note">${esc(e.timeLabel)}</td>
                        <td><span class="badge ${e.tone}">${esc(e.badge)}</span></td>
                        <td class="mono">${e.sourceColor ? `<span class="debug-ch-inline" style="background:${e.sourceColor}"></span>` : ""}<strong>${esc(e.sourceLabel)}</strong></td>
                        <td class="debug-finding-detail">${esc(e.detail)}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
        }
      </div>`;
  }

  private renderNoiseTable(): void {
    const freqs = this.status?.freqs ?? RACEBAND;
    const sweepHz = this.status?.sweepHz ?? 50;
    const summary = this.signalRing.computeStats(this.signalWindowSec, freqs, this.pilots, sweepHz, this.signalEndN);
    const prevScroll = this.slot("noise-table").querySelector<HTMLElement>("[data-findings-scroll]")?.scrollTop ?? 0;

    this.slot("noise-table").innerHTML = `
      <div class="debug-findings" role="region" aria-label="Signal findings log">
        ${this.renderFindingsLogHtml(
          this.signalFindings,
          "clear-signal-findings",
          "Waiting for 50 Hz sweep samples — threshold crossings and in-band RF bursts will be logged here with timestamps."
        )}
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
    const nextScrollEl = this.slot("noise-table").querySelector<HTMLElement>("[data-findings-scroll]");
    if (nextScrollEl && prevScroll > 0) nextScrollEl.scrollTop = prevScroll;
  }

  private renderScan(): void {
    const on = this.console.connected;
    const rfOn = this.status?.rf.enabled ?? true;
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
    const isScanYZoomed = this.scanYMin !== DBM_MIN || this.scanYMax !== DBM_MAX;
    const isWfRowsZoomed = this.spectrumAcc.visibleRows !== 80;
    const canScanOnce = on && rfOn && !this.scanning && !this.scanLive;
    const canScanLive = on && rfOn && !this.scanning;
    const scanActive = this.scanLive || this.scanning;
    this.slot("scan").innerHTML = `
      <div class="debug-card-head">
        <div class="debug-toolbar-left">
          <span class="debug-led-status">
            <span class="status-dot ${scanActive ? "is-up" : ""}" data-scan-led></span>
            <span class="note mono" data-scan-status-note>${this.scanLive ? "Streaming · live scan" : this.scanning ? "Scanning once…" : "Paused"}</span>
          </span>
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
        </div>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm ${this.scanning ? "btn-armed" : "btn-unarmed"}" data-action="scan" ${canScanOnce ? "" : "disabled"} title="${this.scanLive ? "Unavailable while Spectrum scan is streaming" : !rfOn ? "Unavailable while the 5.8 GHz receiver is off" : "Sweep the band once and add a row to the waterfall"}">
            ${icons.target(14)}<span>${this.scanning ? "Scanning…" : "Scan once"}</span>
          </button>
          <button type="button" class="btn btn-sm ${this.scanLive ? "btn-armed" : "btn-unarmed"}" data-action="scan-live" ${canScanLive ? "" : "disabled"} title="${!rfOn ? "Unavailable while the 5.8 GHz receiver is off" : this.scanLive ? "Streaming continuous spectrum scan — click to pause" : "Paused — click to stream continuous spectrum scan (automatically pauses 8-channel stream)"}">
            ${this.scanLive ? icons.pause(14) : icons.play(14)}<span>${this.scanLive ? "Pause" : "Stream"}</span>
          </button>
        </div>
      </div>
      <div class="debug-subbar debug-chart-axisbar">
        <div class="debug-toolbar-left">
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
          <button type="button" class="btn btn-sm btn-ghost" data-action="clear-hold" ${hasScan ? "" : "disabled"}>Reset hold/avg</button>
          <span class="note debug-chart-hint">Drag chart to pan · Shift+drag box to zoom · drag axes to stretch</span>
        </div>
        <div class="debug-connect-actions">
          ${
            isFreqZoomed
              ? `<button type="button" class="btn btn-sm btn-armed mono" data-action="scan-reset-zoom" title="Reset frequency zoom (or double-click chart)">${icons.target(13)}<span>X: ${Math.round(this.scanZoomStartMHz!)}–${Math.round(this.scanZoomStopMHz!)} MHz ×</span></button>`
              : ""
          }
          <button type="button" class="btn btn-sm ${this.scanAutoY ? "btn-armed" : "btn-unarmed"} mono" data-action="scan-auto-y" title="${this.scanAutoY ? "Auto Y-axis scaling is on (fits scanned dBm range) — click for full −100…−20 dBm scale, or drag the Y-axis" : "Manual Y-axis range active — click to re-enable Auto Y scaling"}">
            ${icons.target(13)}<span>${this.scanAutoY ? "Auto Y" : `Y: ${Math.round(this.scanYMin)}…${Math.round(this.scanYMax)} dBm`}</span>
          </button>
          ${
            !this.scanAutoY && isScanYZoomed
              ? `<button type="button" class="btn btn-sm btn-ghost" data-action="scan-reset-y" title="Reset Y-axis to Auto scaling">Auto Y</button>`
              : ""
          }
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
      <div class="debug-findings debug-scan-findings" data-scan-findings role="region" aria-label="Spectrum findings log"></div>
      <div class="debug-waterfall-section">
        <div class="debug-waterfall-head">
          <div class="debug-waterfall-title-group">
            <span class="status-dot" data-wf-led></span>
            <strong>Waterfall spectrogram (frequency × time)</strong>
            <span class="note mono" data-wf-scroll-note></span>
          </div>
          <div class="debug-connect-actions">
            ${
              isWfRowsZoomed
                ? `<button type="button" class="btn btn-sm btn-armed mono" data-action="wf-reset-rows" title="Reset waterfall Y-axis pass depth to 80 passes">${icons.target(13)}<span>Y: ${this.spectrumAcc.visibleRows} passes ×</span></button>`
                : ""
            }
            <button type="button" class="btn btn-sm btn-ghost" data-action="wf-jump-live" data-wf-jump-btn disabled>Jump to live</button>
            <div class="debug-waterfall-legend mono" title="Color scale follows Spectrum Y-axis range">
              <span>${this.spectrumAcc.colorMinDbm} dBm</span>
              <span class="debug-wf-gradient"></span>
              <span>${this.spectrumAcc.colorMaxDbm} dBm</span>
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
    const s = this.spectrumAcc.latest;
    const scanLed = this.el.querySelector<HTMLElement>("[data-scan-led]");
    const scanNote = this.el.querySelector<HTMLElement>("[data-scan-status-note]");
    if (scanLed) {
      scanLed.classList.toggle("is-up", this.scanLive || this.scanning);
    }
    if (scanNote) {
      if (this.scanLive) {
        const rateStr = s?.live && s.passMs ? `${(1000 / s.passMs).toFixed(1)} passes/s` : "live";
        scanNote.textContent = `Streaming · ${rateStr} · ${this.spectrumAcc.avgCount} avg`;
      } else if (this.scanning) {
        scanNote.textContent = "Scanning once…";
      } else if (s) {
        scanNote.textContent = `Paused · ${s.dbm.length} pts`;
      } else {
        scanNote.textContent = "Paused";
      }
    }

    const el = this.el.querySelector<HTMLElement>("[data-scan-findings]");
    if (el) {
      const prevScroll = el.querySelector<HTMLElement>("[data-findings-scroll]")?.scrollTop ?? 0;
      el.innerHTML = this.renderFindingsLogHtml(
        this.scanFindings,
        "clear-scan-findings",
        "Run Scan once or click Stream — detected RF peaks (≥ 6 dB above band median) and 5 GHz Wi-Fi activity will be logged here with timestamps."
      );
      const nextScrollEl = el.querySelector<HTMLElement>("[data-findings-scroll]");
      if (nextScrollEl && prevScroll > 0) nextScrollEl.scrollTop = prevScroll;
    }

    const wfLed = this.el.querySelector<HTMLElement>("[data-wf-led]");
    const wfNote = this.el.querySelector<HTMLElement>("[data-wf-scroll-note]");
    const wfJumpBtn = this.el.querySelector<HTMLButtonElement>("[data-wf-jump-btn]");
    const total = this.spectrumAcc.history.length;
    const vis = this.spectrumAcc.visibleRows;
    const sc = this.spectrumAcc.scrollRow;
    if (wfLed) {
      wfLed.classList.toggle("is-up", (this.scanLive || this.scanning) && sc === 0);
      wfLed.classList.toggle("is-warn", sc > 0);
    }
    if (wfNote) {
      if (!total) {
        wfNote.textContent = "Off · drag horizontally to zoom MHz · wheel/drag vertically to scroll time";
      } else if (sc > 0) {
        wfNote.textContent = `Paused · rows -${sc + 1}..-${Math.min(total, sc + vis)} of ${total}`;
      } else if (total > vis) {
        wfNote.textContent = `${this.scanLive ? "On" : "Off"} · top ${vis} of ${total} passes · wheel to scroll`;
      } else {
        wfNote.textContent = `${this.scanLive ? "On" : "Off"} · ${total} pass${total === 1 ? "" : "es"}`;
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
    const active = this.console.connected && this.logOn;
    if (count) count.textContent = `${active ? "Streaming" : "Paused"} · ${this.logLines.length} lines`;
  }

  private renderLog(): void {
    const on = this.console.connected;
    const active = on && this.logOn;
    this.slot("log").innerHTML = `
      <div class="debug-card-head debug-log-head">
        <span class="debug-led-status">
          <span class="status-dot ${active ? "is-up" : ""}"></span>
          <span class="note mono debug-head-note" data-log-count>${active ? "Streaming" : "Paused"} · ${this.logLines.length} lines</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="clear-log">Clear</button>
          <button type="button" class="btn btn-sm ${this.logOn ? "btn-armed" : "btn-unarmed"}" data-action="log" ${on ? "" : "disabled"} title="${this.logOn ? "Streaming USB log mirror — click to pause" : "Paused — click to stream USB log mirror"}">
            ${this.logOn ? icons.pause(14) : icons.play(14)}<span>${this.logOn ? "Pause" : "Stream"}</span>
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
