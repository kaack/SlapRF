import { computeDirectionalPinch, computeWheelZoomFactors, PinchPoint, scrollOuterPageBy } from "../core/chart_pinch";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { scanSettingsIntroCollapse } from "../core/settings_intro";
import { getAppTheme, subscribeAppTheme } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { TimerReadout } from "../services/esp_flasher";
import { sharedLapRFLink } from "../services/laprf_hardware_link";
import { RHClientDiagSnapshot, sharedRHLink } from "../services/rh_hardware_link";
import {
  BootLog,
  getKnownHardwareTimers,
  KnownHardwareTimer,
  LiveSample,
  MAX_USB_CONNECTIONS,
  recordKnownHardwareTimer,
  ScanResult,
  sharedTimerConsole,
  TimerConsole,
  TimerStatus,
  usbPool,
} from "../services/timer_console";
import { AppStore } from "../state/store";
import { DetectedTimer, isRotorHazardMode, isSlapRFMode, TimingHardwareMode } from "../types/models";
import { patchUsbConnectionBar } from "../widgets/UsbConnectionBar";
import {
  buildFileStamp,
  channelColor,
  DBM_MAX,
  DBM_MIN,
  downloadCanvasPng,
  downloadTextFile,
  drawHealthSparklines,
  drawRHHealthSparklines,
  drawSignalOverTimeCanvas,
  drawSpectrumCanvas,
  drawWaterfallCanvas,
  exportScanHistoryCsv,
  exportSignalCsv,
  exportSpectrumCsv,
  formatHardwareFreq,
  hardwareBandLabel,
  HealthHistory,
  invalidateDebugChartThemeCache,
  PilotThresholdInfo,
  RACEBAND,
  racebandName,
  RHHealthHistory,
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

interface DebugTimerInfo {
  found: boolean;
  timerId?: number;
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
  channelIndex?: number;
  freqMHz?: number;
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
  private console: TimerConsole;
  private unsubConsole: (() => void) | null = null;
  private status: TimerStatus | null = null;
  private live: LiveSample | null = null;
  private liveCount = 0;
  private liveOn = false;
  /** 1 = ~10 Hz bar stream; 2 = every-sweep (50 Hz) when the Signal-over-time card is visible. */
  private liveMode: 1 | 2 = 2;
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
  private bootLog: BootLog | null = null;
  private progress = "";
  private channelsDirty = false;

  // Chart buffers & state (§5)
  private readonly signalRing = new SignalRingBuffer();
  private readonly spectrumAcc = new SpectrumAccumulator();
  private readonly healthHistory = new HealthHistory();
  private readonly rhHealthHistory = new RHHealthHistory();
  private pilots: PilotThresholdInfo[] = [];
  private serverTimers: DetectedTimer[] = [];
  private serverGates: Array<{
    gateId: number;
    assignedTimerId: number;
    timerLabel: string;
    name: string;
    role: string;
    trackOrder: number;
    online: boolean;
    framesRxCount?: number;
    lastRssi?: number[];
  }> = [];
  private serverSimActive = false;
  private hasServer = false;
  private readonly api?: ApiClient;
  private readonly store?: AppStore;
  private lastSyncedHwMode: TimingHardwareMode = "slaprf";
  private selectedRhTimerId: number | null = null;
  private rhLiveOn = false;
  private rhSampleSeq = 0;
  private rhLastHeartbeatsRx = -1;
  private rhLastSamplePushAt = 0;
  private rhLastHealthPushAt = 0;
  private rhLastScanSeq = 0;
  private rhNodeBaseline: number[] = [-128, -128, -128, -128, -128, -128, -128, -128];
  private rhStructuralDigest = "";
  private rhPollTimer = 0;
  private rhPollInFlight = false;
  private selectedNetworkSpokeSlot: number | null = null;
  private spokeRateTracker = new Map<number, { frames: number; atMs: number; ratePktPerSec: number }>();

  private signalWindowSec = 15;
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
  private chanMaskToggledAt = 0;
  private barFillVal: number[] = [-127, -127, -127, -127, -127, -127, -127, -127];
  private barFillAt: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  private barPeakVal: number[] = [-127, -127, -127, -127, -127, -127, -127, -127];
  private barPeakAt: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  private signalShowFloor = true;
  private signalShowHitLine = true;
  private signalShowThresholds = true;
  private signalHover: { x: number; y: number } | null = null;

  private scanShowMaxHold = true;
  private scanShowAvg = true;
  private scanShowWifi = true;
  private scanStartMHz = 5180;
  private resumeLiveAfterReconnect = false;
  private resumeScanLiveAfterReconnect = false;
  private scanStopMHz = 5945;
  private scanStepMHz = 5;
  private scanZoomStartMHz: number | null = null;
  private scanZoomStopMHz: number | null = null;
  private scanAutoY = false;
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
  private openAxisMenu: "signal-x" | "signal-y" | "scan-band" | "scan-x" | "scan-y" | "wf-x" | "wf-y" | null = null;
  private serialLines: string[] = [];
  private serialHistory: string[] = [];
  private serialHistoryIdx = -1;
  private serialDraft = "";
  private serialAwaitUntil = 0;
  private serialExpectStatus = false;
  private serialWrap = false;
  private logWrap = false;

  constructor(el: HTMLElement, api?: ApiClient, store?: AppStore) {
    super(el);
    this.api = api;
    this.store = store;
    this.lastSyncedHwMode = store?.timingHardwareMode ?? "slaprf";
    this.console = usbPool.debugConsole;
    this.loadDebugPrefs();
    if (this.isRotorHazardMode()) {
      this.signalAutoY = true;
      this.signalSmoothYMin = null;
      this.signalSmoothYMax = null;
      this.signalYMin = 0;
      this.signalYMax = 140;
    }
    if (this.isRotorHazardUSBMode()) {
      const sb = this.scanYBounds();
      this.scanAutoY = true;
      this.scanYMin = 0;
      this.scanYMax = 120;
      this.scanStopMHz = Math.min(sb.maxFreqMHz, this.scanStopMHz);
      this.syncScanColorRange();
    }

    el.innerHTML = `
      <div class="settings debug-page">
        <section class="settings-section" data-section-anchor="connection">
          <div class="settings-intro">
            <h2>Connection</h2>
            <p>Inspects the main USB connection by default. Click <strong>Debug another USB</strong> to inspect a second USB device without disconnecting the main one.</p>
          </div>
          <div class="debug-status-layout" data-slot="connection"></div>
        </section>
        <section class="settings-section" data-section-anchor="self-test">
          <div class="settings-intro">
            <h2>Self-test</h2>
            <p>Runs a 10-second end-to-end check: console, identity, 5.8 GHz receiver, sweep timing, memory, last restart, course link, and engine feed. Copy the report when troubleshooting.</p>
          </div>
          <div class="card card-flush" data-slot="selftest"></div>
        </section>
        <section class="settings-section" data-section-anchor="status-health">
          <div class="settings-intro">
            <h2>Status &amp; health</h2>
            <p>Identity, chip, uptime, last restart reason, free memory, sweep timing, and 5.8 GHz boot check. Updates every 2 seconds with a 5-minute trend.</p>
          </div>
          <div class="debug-status-layout">
            <div data-slot="status"></div>
            <div class="debug-subbox debug-health-subbox" data-slot="health">
              <div class="debug-subbox-head">
                <span class="debug-subbox-title" data-health-title>${icons.chart(14)}<span>Health trends</span></span>
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
                    <span class="debug-health-title">Server frames rx</span>
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
        <section class="settings-section" data-section-anchor="monitored-channels">
          <div class="settings-intro">
            <h2>Monitored channels</h2>
            <p>The 8 pilot channels scanned each sweep. Click a channel to toggle it on or off (fewer active channels sweep faster). Click <strong>Stream</strong> for live 5.8 GHz signal bars.</p>
          </div>
          <div class="debug-status-layout">
            <div data-slot="live-head"></div>
            <div class="debug-subbox" data-slot="live"></div>
          </div>
        </section>
        <section class="settings-section" data-signal-section data-section-anchor="signal-noise">
          <div class="settings-intro">
            <h2>Signal over time &amp; channel noise</h2>
            <p>Click <strong>Stream</strong> to plot live 50 Hz sweeps, crossing peaks, 5 GHz Wi-Fi bursts, noise floors, and pilot thresholds.</p>
            <p>The table below shows mean, spread, max, floor, hits/s, and how often noise reaches a pilot's enter threshold ("would trigger": anything above 0% with no drone flying risks false passes).</p>
          </div>
          <div class="debug-status-layout">
            <div data-slot="signal-head"></div>
            <div class="debug-subbox">
              <div data-slot="signal-controls"></div>
              <div class="debug-canvas-wrap">
                <canvas class="debug-canvas debug-signal-canvas" data-signal-canvas></canvas>
              </div>
              <div class="debug-chart-readout debug-single-readout" data-signal-readout></div>
              <div data-slot="signal-legend"></div>
            </div>
            <div class="debug-status-layout" data-slot="noise-table"></div>
          </div>
        </section>
        <section class="settings-section" data-section-anchor="spectrum-scan">
          <div class="settings-intro">
            <h2>Spectrum scan &amp; waterfall</h2>
            <p>Scans 5180–5917 MHz to spot rogue VTXs or 5 GHz Wi-Fi interference (Raceband <strong>R3–R6 overlap Wi-Fi UNII-3</strong>, channels 149–165, 5735–5835 MHz).</p>
            <p><strong>Scan once</strong> captures a single sweep. <strong>Stream</strong> scans continuously with live, average, and max-hold traces (pausing the 8-channel stream while active).</p>
          </div>
          <div class="debug-status-layout" data-slot="scan"></div>
        </section>
        <section class="settings-section" data-section-anchor="serial-console">
          <div class="settings-intro">
            <h2>Serial console</h2>
            <p>USB terminal for sending commands directly to the timer and reading boot/crash logs. Type <span class="mono">HELP</span> for commands.</p>
          </div>
          <div class="card card-flush" data-slot="serial-console"></div>
        </section>
        <section class="settings-section" data-section-anchor="live-log">
          <div class="settings-intro">
            <h2>Live log</h2>
            <p>Live firmware log messages mirrored over USB.</p>
          </div>
          <div class="card card-flush" data-slot="log"></div>
        </section>
      </div>`;

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-serial-terminal]") && !target.closest("[data-serial-input]")) {
        const sel = window.getSelection()?.toString() ?? "";
        if (!sel) {
          this.el.querySelector<HTMLInputElement>("[data-serial-input]")?.focus();
        }
      }
      void this.onClick(e);
    });
    this.listen(el, "keydown", (e) => {
      const ke = e as KeyboardEvent;
      const t = ke.target as HTMLElement | null;
      if (!t || !t.matches("[data-serial-input]")) return;
      const inp = t as HTMLInputElement;
      if (ke.key === "l" && (ke.ctrlKey || ke.metaKey)) {
        ke.preventDefault();
        this.serialLines = [];
        this.renderSerialConsole();
        this.el.querySelector<HTMLInputElement>("[data-serial-input]")?.focus();
      } else if (ke.key === "Tab") {
        ke.preventDefault();
        const cur = inp.value.trimStart().toUpperCase();
        if (!cur) return;
        const cmds = [
          "STATUS?",
          "RF ",
          "LIVE ",
          "SCAN ",
          "SCAN LIVE ",
          "SCAN STOP",
          "CHANNELS ",
          "CHANNELS MASK ",
          "CHANNELS RESET",
          "LOG ",
          "BOOTLOG?",
          "LASTLOG?",
          "SLAPRF?",
          "REBOOT",
          "HELP",
          "CLEAR",
        ];
        const match = cmds.find((c) => c.startsWith(cur));
        if (match) inp.value = match;
      } else if (ke.key === "Enter") {
        ke.preventDefault();
        void this.sendSerialCommand(inp.value);
      } else if (ke.key === "ArrowUp") {
        ke.preventDefault();
        if (!this.serialHistory.length) return;
        if (this.serialHistoryIdx === -1) {
          this.serialDraft = inp.value;
          this.serialHistoryIdx = this.serialHistory.length - 1;
        } else if (this.serialHistoryIdx > 0) {
          this.serialHistoryIdx--;
        }
        inp.value = this.serialHistory[this.serialHistoryIdx] ?? "";
      } else if (ke.key === "ArrowDown") {
        ke.preventDefault();
        if (this.serialHistoryIdx === -1) return;
        if (this.serialHistoryIdx < this.serialHistory.length - 1) {
          this.serialHistoryIdx++;
          inp.value = this.serialHistory[this.serialHistoryIdx] ?? "";
        } else {
          this.serialHistoryIdx = -1;
          inp.value = this.serialDraft;
        }
      }
    });
    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-all-ports]")) {
        this.showAllPorts = t.checked;
        this.console.showAllPorts = t.checked;
        this.saveDebugPrefs();
      } else if (t.matches("[data-check]")) void this.onCheckChange(t);
    });
    this.listen(el, "input", (e) => {
      const t = e.target as HTMLElement;
      if (t.matches("[data-chan]")) {
        this.syncChannelInputsState();
      }
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

    const unsubPool = usbPool.onChange(() => {
      const target = usbPool.debugConsole;
      if (target !== this.console) {
        this.bindConsole(target);
      } else if (this.isSlapRFMode()) {
        this.renderConnection();
      }
    });

    const onExternalState = () => {
      const curMode = this.hwMode();
      if (curMode !== this.lastSyncedHwMode) {
        if (isRotorHazardMode(this.lastSyncedHwMode)) {
          this.rhLiveOn = false;
          void this.api?.setRHDebugStream?.(0, false)?.catch(() => undefined);
          if (this.lastSyncedHwMode === "rotorhazard_usb" && this.store) {
            void sharedRHLink
              .runUSBScan(this.store, this.api, { timerId: 0, mode: "stop", start: 5180, stop: 5945, step: 5 })
              .catch(() => undefined);
          }
        }
        this.lastSyncedHwMode = curMode;
        this.resetSignalBuffersForTargetChange();
        this.syncHardwareModeDom();
        this.renderAll();
        return;
      }
      if (this.isRotorHazardMode()) {
        this.ingestRotorHazardSample();
      } else if (this.isLapRFMode()) {
        this.renderConnection();
      }
    };

    const unsubStore = this.store ? this.store.subscribe(["config", "status"], onExternalState) : null;
    const unsubRH = this.store ? sharedRHLink.subscribe(onExternalState) : null;
    const unsubLapRF = this.store ? sharedLapRFLink.subscribe(onExternalState) : null;
    const unsubTheme = subscribeAppTheme(() => {
      invalidateDebugChartThemeCache();
      this.spectrumAcc.repaintForTheme();
      this.renderAll();
    });

    if (this.store) {
      this.rhPollTimer = window.setInterval(() => {
        void this.tickNonSlapRFTelemetry();
      }, 45);
    }

    this.onDispose(() => {
      unsubPool();
      unsubStore?.();
      unsubRH?.();
      unsubLapRF?.();
      unsubTheme();
      this.unsubConsole?.();
      this.unsubConsole = null;
      this.console.setBusyLabel(null);
      window.cancelAnimationFrame(this.rafId);
      window.removeEventListener("resize", onResize);
      this.observer?.disconnect();
      window.clearInterval(this.statusTimer);
      window.clearInterval(this.rhPollTimer);
      const wasRhActive = this.rhLiveOn || this.isRotorHazardMode();
      const wasRhUsbScan = (this.scanLive || this.scanning) && this.isRotorHazardUSBMode();
      if (this.rhLiveOn) {
        this.rhLiveOn = false;
      }
      if (wasRhActive) {
        void this.api?.setRHDebugStream?.(0, false)?.catch(() => undefined);
      }
      if (wasRhUsbScan && this.store) {
        this.scanLive = false;
        this.scanning = false;
        void sharedRHLink
          .runUSBScan(this.store, this.api, { timerId: 0, mode: "stop", start: 5180, stop: 5945, step: 5 })
          .catch(() => undefined);
      }
      // Leaving the Debug page must stop high-rate LIVE / SCAN / LOG streaming,
      // and if a secondary debug USB device (Slot 1) is connected, disconnect it and revert to main.
      this.stopActiveStreamsOn(this.console);
      if (usbPool.debugSlotIndex === 1 || usbPool.slots[1]?.connected) {
        void usbPool.revertDebugToMain();
      }
    });
    this.syncHardwareModeDom();
    this.bindConsole(this.console);
    if (this.isRotorHazardMode()) {
      void this.tickNonSlapRFTelemetry();
    }
    this.renderFrame();
  }

  public override onDeactivate(): void {
    const hadActiveStream =
      this.liveOn ||
      this.scanLive ||
      Boolean(this.status?.scanLive) ||
      this.logOn ||
      Boolean(this.status?.freqsTemporary) ||
      this.status?.rf.enabled === false;
    this.stopActiveStreamsOn(this.console);
    if (this.liveOn || this.scanLive || this.logOn) {
      this.liveOn = false;
      this.scanLive = false;
      this.logOn = false;
      this.resumeLiveAfterReconnect = false;
      this.resumeScanLiveAfterReconnect = false;
    }
    if (this.rhLiveOn) {
      this.rhLiveOn = false;
      void this.api?.setRHDebugStream?.(0, false)?.catch(() => undefined);
    }
    if ((this.scanLive || this.scanning) && this.isRotorHazardUSBMode() && this.store) {
      this.scanLive = false;
      this.scanning = false;
      void sharedRHLink
        .runUSBScan(this.store, this.api, { timerId: 0, mode: "stop", start: 5180, stop: 5945, step: 5 })
        .catch(() => undefined);
    }
    if (usbPool.debugSlotIndex === 1 || usbPool.slots[1]?.connected) {
      void usbPool.revertDebugToMain();
    }
    if (hadActiveStream) {
      this.renderAll();
    }
  }

  private hwMode(): TimingHardwareMode {
    return this.store?.timingHardwareMode ?? "slaprf";
  }

  private isSlapRFMode(): boolean {
    return isSlapRFMode(this.hwMode());
  }

  private isSlapRFBLEMode(): boolean {
    return this.hwMode() === "slaprf_ble";
  }

  private isRotorHazardMode(): boolean {
    return isRotorHazardMode(this.hwMode());
  }

  private isRotorHazardUSBMode(): boolean {
    return this.hwMode() === "rotorhazard_usb";
  }

  private isLapRFMode(): boolean {
    return this.hwMode() === "laprf";
  }

  private activeSweepHz(): number {
    if (this.isRotorHazardUSBMode()) return 25;
    if (this.isRotorHazardMode()) return 10;
    return this.status?.sweepHz ?? 50;
  }

  private hasSpectrumScanSupport(): boolean {
    return this.isSlapRFMode() || this.isRotorHazardUSBMode();
  }

  private scanYBounds(): {
    min: number;
    max: number;
    minSpan: number;
    defaultColorMin: number;
    defaultColorMax: number;
    unit: string;
    maxFreqMHz: number;
    rssiScale: boolean;
  } {
    if (this.isRotorHazardUSBMode()) {
      return {
        min: 0,
        max: 255,
        minSpan: 24,
        defaultColorMin: 12,
        defaultColorMax: 185,
        unit: "RSSI",
        maxFreqMHz: 5945,
        rssiScale: true,
      };
    }
    return {
      min: DBM_MIN,
      max: DBM_MAX,
      minSpan: 16,
      defaultColorMin: -100,
      defaultColorMax: -40,
      unit: "dBm",
      maxFreqMHz: 5945,
      rssiScale: false,
    };
  }

  private syncScanColorRange(): void {
    const sb = this.scanYBounds();
    if (
      (this.scanAutoY && !this.spectrumAcc.latest) ||
      (!this.scanAutoY && Math.round(this.scanYMin) === sb.min && Math.round(this.scanYMax) === sb.max)
    ) {
      this.spectrumAcc.setColorRange(sb.defaultColorMin, sb.defaultColorMax, sb.rssiScale);
      return;
    }
    if (sb.rssiScale) {
      const lo = Math.max(0, Math.min(220, this.scanYMin + 4));
      const hi = Math.max(lo + 16, Math.min(255, this.scanYMax));
      this.spectrumAcc.setColorRange(lo, hi, true);
    } else {
      this.spectrumAcc.setColorRange(this.scanYMin, Math.min(-25, this.scanYMax), false);
    }
  }

  private async runRhUsbScanCommand(
    mode: "once" | "live" | "stop",
    startMHz = this.scanStartMHz,
    stopMHz = this.scanStopMHz,
    stepMHz = this.scanStepMHz,
    timerIdOverride?: number
  ): Promise<void> {
    if (!this.store) return;
    const sb = this.scanYBounds();
    const tid = timerIdOverride !== undefined ? timerIdOverride : (this.activeRhSnapshot()?.timerId ?? 0);
    const start = Math.max(5180, Math.min(sb.maxFreqMHz - 5, Math.round(startMHz)));
    const stop = Math.max(start + 5, Math.min(sb.maxFreqMHz, Math.round(stopMHz)));
    const step = Math.max(1, Math.min(50, Math.round(stepMHz)));
    const res = await sharedRHLink.runUSBScan(this.store, this.api, {
      timerId: tid,
      mode,
      start,
      stop,
      step,
    });
    if (mode === "once" && res.scan && Array.isArray(res.scan.values)) {
      this.rhLastScanSeq = res.scan.seq || 0;
      this.ingestScanPassResult({
        start: res.scan.start,
        step: res.scan.step,
        dbm: res.scan.values.map((v) => Math.round(v)),
        passMs: res.scan.passMs,
        live: false,
      });
    }
  }

  private ingestScanPassResult(s: ScanResult, partial = false): void {
    const gridChanged =
      this.spectrumAcc.latest !== null &&
      (this.spectrumAcc.latest.start !== s.start ||
        this.spectrumAcc.latest.step !== s.step ||
        this.spectrumAcc.latest.dbm.length !== s.dbm.length);
    if (gridChanged) {
      this.scanZoomStartMHz = null;
      this.scanZoomStopMHz = null;
    }
    if (partial) {
      this.spectrumAcc.updatePartialScan(s);
    } else {
      this.spectrumAcc.pushScan(s);
      this.recordScanFindingFromPass(s);
      if (!s.live) {
        this.scanning = false;
        this.renderScan();
      } else {
        this.updateScanFindings();
      }
    }
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
  }

  private signalYBounds(): {
    min: number;
    max: number;
    minSpan: number;
    floorPresetMin: number;
    floorPresetMax: number;
    unit: string;
  } {
    if (this.isRotorHazardMode()) {
      return {
        min: 0,
        max: 255,
        minSpan: 36,
        floorPresetMin: 0,
        floorPresetMax: 130,
        unit: "RSSI",
      };
    }
    return {
      min: DBM_MIN,
      max: DBM_MAX,
      minSpan: 18,
      floorPresetMin: -102,
      floorPresetMax: -68,
      unit: "dBm",
    };
  }

  private getRhSnapshots(): RHClientDiagSnapshot[] {
    return this.store ? sharedRHLink.snapshots(this.store) : [];
  }

  private activeRhSnapshot(): RHClientDiagSnapshot | null {
    const snaps = this.getRhSnapshots();
    if (snaps.length === 0) return null;
    if (this.selectedRhTimerId !== null) {
      const exact = snaps.find((s) => s.timerId === this.selectedRhTimerId);
      if (exact) return exact;
    }
    const chosen = snaps.find((s) => s.connected) ?? snaps[0];
    this.selectedRhTimerId = chosen.timerId;
    return chosen;
  }

  private async syncRhDebugStream(active: boolean, timerIdOverride?: number): Promise<void> {
    const tid = timerIdOverride !== undefined ? timerIdOverride : (this.activeRhSnapshot()?.timerId ?? 0);
    if (this.api?.setRHDebugStream && (tid > 0 || !active)) {
      await this.api.setRHDebugStream(tid, active).catch(() => undefined);
    }
    if (this.store?.simulatorRunning) {
      await this.api?.pollStatusNow().catch(() => undefined);
    } else {
      await sharedRHLink.refreshStatus().catch(() => undefined);
    }
    this.ingestRotorHazardSample();
  }

  private resetSignalBuffersForTargetChange(): void {
    this.live = null;
    this.liveCount = 0;
    this.signalRing.clear();
    this.rhHealthHistory.clear();
    this.signalEndN = null;
    this.signalAutoY = true;
    this.signalSmoothYMin = null;
    this.signalSmoothYMax = null;
    const yb = this.signalYBounds();
    this.signalYMin = this.isRotorHazardMode() ? 0 : -100;
    this.signalYMax = this.isRotorHazardMode() ? 140 : -78;
    void yb;
    this.barFillVal = [-127, -127, -127, -127, -127, -127, -127, -127];
    this.barFillAt = [0, 0, 0, 0, 0, 0, 0, 0];
    this.barPeakVal = [-127, -127, -127, -127, -127, -127, -127, -127];
    this.barPeakAt = [0, 0, 0, 0, 0, 0, 0, 0];
    this.rhNodeBaseline = [-128, -128, -128, -128, -128, -128, -128, -128];
    this.rhLastHeartbeatsRx = -1;
    this.rhLastSamplePushAt = 0;
    this.rhLastHealthPushAt = 0;
    this.rhStructuralDigest = "";
    this.signalFindings = [];
    this.signalFindingSeq = 0;
    this.scanning = false;
    this.scanLive = false;
    this.rhLastScanSeq = 0;
    this.spectrumAcc.clearAll();
    this.scanFindings = [];
    this.scanFindingSeq = 0;
    const sb = this.scanYBounds();
    this.scanAutoY = this.isRotorHazardUSBMode();
    this.scanYMin = sb.min;
    this.scanYMax = this.isRotorHazardUSBMode() ? 120 : sb.max;
    this.scanZoomStartMHz = null;
    this.scanZoomStopMHz = null;
    if (this.scanStopMHz === 5917 || this.scanStopMHz === 5925 || this.scanStopMHz > sb.maxFreqMHz) {
      this.scanStopMHz = sb.maxFreqMHz;
    }
    this.syncScanColorRange();
    this.checks = [];
    this.checksAt = null;
    this.reportExtra = "";
    this.dirtySignal = true;
    this.dirtyNoiseTable = true;
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
    this.dirtyHealth = true;
  }

  private syncHardwareModeDom(): void {
    const mode = this.hwMode();
    const isSlap = isSlapRFMode(mode);
    const isSlapBLE = mode === "slaprf_ble";
    const isRHNet = mode === "rotorhazard";
    const isRHUSB = mode === "rotorhazard_usb";
    const isLapRF = mode === "laprf";

    const setHidden = (anchor: string, hide: boolean) => {
      const sec = this.el.querySelector<HTMLElement>(`[data-section-anchor="${anchor}"]`);
      if (sec) {
        sec.hidden = hide;
        sec.style.display = hide ? "none" : "";
      }
    };
    // Spectrum scan & waterfall work on both SlapRF timers and direct RotorHazard USB nodes (0-255 scale).
    setHidden("spectrum-scan", !(isSlap || isRHUSB));
    setHidden("serial-console", !isSlap);
    setHidden("live-log", !isSlap);
    // In LapRF mode, hide RF diagnostic sections that apply to SlapRF / RotorHazard node telemetry.
    setHidden("self-test", isLapRF);
    setHidden("status-health", isLapRF);
    setHidden("monitored-channels", isLapRF);
    setHidden("signal-noise", isLapRF);

    const setIntro = (anchor: string, titleHtml: string, bodyHtml: string) => {
      const intro = this.el.querySelector<HTMLElement>(`[data-section-anchor="${anchor}"] > .settings-intro`);
      if (!intro) return;
      const next = `<h2>${titleHtml}</h2>${bodyHtml}`;
      if (intro.innerHTML !== next) {
        intro.innerHTML = next;
      }
    };

    if (isRHUSB) {
      setIntro(
        "connection",
        "Connection",
        `<p>Select a RotorHazard USB serial node to inspect its binary serial link, receiver nodes, serial RTT, and live 0-255 RSSI telemetry.</p>`
      );
      setIntro(
        "self-test",
        "Self-test",
        `<p>Runs an end-to-end check on the selected RotorHazard USB device: serial port &amp; API handshake, node count, RF frequency tuning, serial RTT, baseline headroom, and ~10 Hz RSSI poll stream.</p>`
      );
      setIntro(
        "status-health",
        "Status &amp; health",
        `<p>Serial API level, baud rate, receiver node assignments, gate state, serial RTT, and live telemetry counters.</p>`
      );
      setIntro(
        "monitored-channels",
        "Monitored channels",
        `<p>Live 0-255 RSSI across the USB device's receiver nodes with hardware Enter / Exit thresholds. Click a node row to show or hide its trace.</p>`
      );
      setIntro(
        "signal-noise",
        "Signal over time &amp; channel noise",
        `<p>Plots live ~10 Hz RotorHazard USB RSSI (0-255), crossing peaks, baseline noise, and hardware Enter / Exit thresholds per receiver node.</p><p>The table below shows mean, spread, max, floor, and how often baseline noise reaches each node's EnterAt threshold ("would trigger").</p>`
      );
      setIntro(
        "spectrum-scan",
        "Spectrum scan &amp; waterfall",
        `<p>Sweeps 5180-5945 MHz across the USB device's receiver nodes on a 0-255 RSSI scale to spot active VTXs or 5 GHz Wi-Fi interference (Raceband <strong>R3-R6 overlap Wi-Fi UNII-3</strong>, channels 149-165, 5735-5835 MHz).</p><p><strong>Scan once</strong> captures a single sweep and restores node frequencies. <strong>Stream</strong> sweeps continuously with live, average, and max-hold traces (pausing normal node polling while active).</p>`
      );
    } else if (isRHNet) {
      setIntro(
        "connection",
        "Connection",
        `<p>Select a RotorHazard timer on the network to inspect its Socket.IO link, RX5808 receiver nodes, clock sync, and live RSSI telemetry.</p>`
      );
      setIntro(
        "self-test",
        "Self-test",
        `<p>Runs an end-to-end check on the selected RotorHazard timer: Socket.IO link, admin authentication, server version &amp; node count, node RF tuning, clock sync, baseline headroom, and ~10 Hz heartbeat stream.</p>`
      );
      setIntro(
        "status-health",
        "Status &amp; health",
        `<p>Server version, hostname, RX5808 receiver node assignments, authentication &amp; gate state, clock offset, and environmental sensors with a 5-minute trend.</p>`
      );
      setIntro(
        "monitored-channels",
        "Monitored channels",
        `<p>Live 0–255 RSSI across the timer's RX5808 receiver nodes with hardware Enter / Exit thresholds. Click a node row to show or hide its trace.</p>`
      );
      setIntro(
        "signal-noise",
        "Signal over time &amp; channel noise",
        `<p>Plots live ~10 Hz RotorHazard heartbeat RSSI (0–255), crossing peaks, baseline noise, and hardware Enter / Exit thresholds per receiver node.</p><p>The table below shows mean, spread, max, floor, and how often baseline noise reaches each node's EnterAt threshold ("would trigger").</p>`
      );
    } else if (isLapRF) {
      setIntro(
        "connection",
        "Connection",
        `<p>Select or connect a LapRF 8-Way timer over Ethernet TCP (<span class="mono">:5403</span>) or USB CDC. Manage hardware endpoints on the Network page.</p>`
      );
    } else if (isSlapBLE) {
      setIntro(
        "connection",
        "Bluetooth Hub",
        `<p>Connect a SlapRF Bluetooth Hub wirelessly over Bluetooth LE to inspect its GATT link, sweep phase lock, and live 5.8 GHz receiver telemetry.</p>`
      );
      setIntro(
        "self-test",
        "Self-test",
        `<p>Runs a 10-second end-to-end check over Bluetooth: console, identity, 5.8 GHz receiver, sweep timing, memory, last restart, BLE link sync, and engine feed. Copy the report when troubleshooting.</p>`
      );
      setIntro(
        "status-health",
        "Status &amp; health",
        `<p>Identity, Bluetooth LE link &amp; pairing state, uptime, last restart reason, free memory, sweep timing, and 5.8 GHz boot check. Updates every 2 seconds with a 5-minute trend.</p>`
      );
      setIntro(
        "monitored-channels",
        "Monitored channels",
        `<p>The 8 pilot channels scanned each sweep by the Bluetooth Hub. Click a channel to toggle it on or off (fewer active channels sweep faster). Click <strong>Stream</strong> for live 5.8 GHz signal bars.</p>`
      );
      setIntro(
        "signal-noise",
        "Signal over time &amp; channel noise",
        `<p>Click <strong>Stream</strong> to plot live 50 Hz sweeps over Bluetooth, crossing peaks, 5 GHz Wi-Fi bursts, noise floors, and pilot thresholds.</p><p>The table below shows mean, spread, max, floor, hits/s, and how often noise reaches a pilot's enter threshold ("would trigger": anything above 0% with no drone flying risks false passes).</p>`
      );
      setIntro(
        "spectrum-scan",
        "Spectrum scan &amp; waterfall",
        `<p>Scans 5180-5917 MHz on the Bluetooth Hub to spot rogue VTXs or 5 GHz Wi-Fi interference (Raceband <strong>R3-R6 overlap Wi-Fi UNII-3</strong>, channels 149-165, 5735-5835 MHz).</p><p><strong>Scan once</strong> captures a single sweep. <strong>Stream</strong> scans continuously with live, average, and max-hold traces (pausing the 8-channel stream while active).</p>`
      );
    } else {
      setIntro(
        "connection",
        "Connection",
        `<p>Inspects the main USB connection by default. Click <strong>Debug another USB</strong> to inspect a second USB device without disconnecting the main one.</p>`
      );
      setIntro(
        "self-test",
        "Self-test",
        `<p>Runs a 10-second end-to-end check: console, identity, 5.8 GHz receiver, sweep timing, memory, last restart, course link, and engine feed. Copy the report when troubleshooting.</p>`
      );
      setIntro(
        "status-health",
        "Status &amp; health",
        `<p>Identity, chip, uptime, last restart reason, free memory, sweep timing, and 5.8 GHz boot check. Updates every 2 seconds with a 5-minute trend.</p>`
      );
      setIntro(
        "monitored-channels",
        "Monitored channels",
        `<p>The 8 pilot channels scanned each sweep. Click a channel to toggle it on or off (fewer active channels sweep faster). Click <strong>Stream</strong> for live 5.8 GHz signal bars.</p>`
      );
      setIntro(
        "signal-noise",
        "Signal over time &amp; channel noise",
        `<p>Click <strong>Stream</strong> to plot live 50 Hz sweeps, crossing peaks, 5 GHz Wi-Fi bursts, noise floors, and pilot thresholds.</p><p>The table below shows mean, spread, max, floor, hits/s, and how often noise reaches a pilot's enter threshold ("would trigger": anything above 0% with no drone flying risks false passes).</p>`
      );
      setIntro(
        "spectrum-scan",
        "Spectrum scan &amp; waterfall",
        `<p>Scans 5180-5917 MHz to spot rogue VTXs or 5 GHz Wi-Fi interference (Raceband <strong>R3-R6 overlap Wi-Fi UNII-3</strong>, channels 149-165, 5735-5835 MHz).</p><p><strong>Scan once</strong> captures a single sweep. <strong>Stream</strong> scans continuously with live, average, and max-hold traces (pausing the 8-channel stream while active).</p>`
      );
    }
    if (this.el.offsetWidth > 0) {
      scanSettingsIntroCollapse(this.el);
    }
  }

  private async tickNonSlapRFTelemetry(): Promise<void> {
    if (!this.isRotorHazardMode()) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.rhPollInFlight) return;
    this.rhPollInFlight = true;
    try {
      if (this.store?.simulatorRunning) {
        await this.api?.pollStatusNow();
      } else {
        await sharedRHLink.refreshStatus();
      }
      this.ingestRotorHazardSample();
    } finally {
      this.rhPollInFlight = false;
    }
  }

  private ingestRotorHazardSample(): void {
    if (!this.isRotorHazardMode()) return;
    const isUSB = this.isRotorHazardUSBMode();
    const snaps = this.getRhSnapshots();
    const snap = this.activeRhSnapshot();
    if (isUSB && snap && !snap.connected && (this.scanLive || this.scanning)) {
      this.scanLive = false;
      this.scanning = false;
    }
    const structKey = JSON.stringify({
      list: snaps.map((s) => [s.timerId, s.label, s.endpoint, s.connected, s.authOk, s.nodeCount, s.serverVersion, s.gateArmed]),
      sel: snap?.timerId ?? null,
      freqs: snap?.nodeFreqsMhz ?? [],
      enters: snap?.nodeEnterLevels ?? [],
      exits: snap?.nodeExitLevels ?? [],
      liveOn: this.rhLiveOn,
      scanLive: isUSB ? this.scanLive : false,
      sim: Boolean(this.store?.simulatorRunning),
    });
    if (structKey !== this.rhStructuralDigest) {
      this.rhStructuralDigest = structKey;
      this.renderConnection();
      this.renderSelfTest();
      this.renderStatus();
      this.renderLiveHead();
      this.renderLive();
      this.renderSignalControls();
      this.renderNoiseTable();
      if (isUSB) {
        this.renderScan();
      }
    }

    if (!snap) return;

    // Update fast-changing status text in place without replacing DOM nodes
    const clockEl = this.el.querySelector<HTMLElement>("[data-rh-live-clock]");
    if (clockEl) {
      clockEl.textContent = snap.connected
        ? `${snap.clockSynced ? "Synced" : "Syncing"} · ${snap.clockOffsetMs >= 0 ? "+" : ""}${snap.clockOffsetMs.toFixed(1)} ms`
        : "-";
    }
    const telemEl = this.el.querySelector<HTMLElement>("[data-rh-live-telem]");
    if (telemEl) {
      telemEl.textContent = snap.connected
        ? `${snap.heartbeatsRx} ${isUSB ? "polls" : "heartbeats"} · ${snap.passesRx} passes`
        : "-";
    }
    const envEl = this.el.querySelector<HTMLElement>("[data-rh-live-env]");
    if (envEl) {
      envEl.textContent = snap.connected
        ? snap.envSummary || (snap.cpuTempC && snap.cpuTempC > 0 ? `Pi CPU ${snap.cpuTempC.toFixed(1)} °C` : "No sensor reported")
        : "-";
    }

    if (!snap.connected) return;

    if (isUSB && this.scanLive && snap.lastScan && Array.isArray(snap.lastScan.values)) {
      if (snap.lastScan.seq !== this.rhLastScanSeq) {
        this.rhLastScanSeq = snap.lastScan.seq;
        this.ingestScanPassResult(
          {
            start: snap.lastScan.start,
            step: snap.lastScan.step,
            dbm: snap.lastScan.values.map((v) => Math.round(v)),
            passMs: snap.lastScan.passMs,
            live: true,
          },
          Boolean(snap.lastScan.partial)
        );
      }
    }

    const now = performance.now();
    const hbChanged = snap.heartbeatsRx !== this.rhLastHeartbeatsRx;
    const minSampleGapMs = isUSB ? 45 : 150;
    if (this.rhLiveOn && !this.scanLive && (hbChanged || now - this.rhLastSamplePushAt >= minSampleGapMs)) {
      this.rhLastHeartbeatsRx = snap.heartbeatsRx;
      this.rhLastSamplePushAt = now;
      const nodeCount = snap.nodeCount === 4 ? 4 : 8;
      const dbm = new Array<number>(8).fill(-128);
      const floor = new Array<number>(8).fill(-128);
      const hits = new Array<number>(8).fill(0);
      for (let i = 0; i < nodeCount; i++) {
        const f = snap.nodeFreqsMhz[i] ?? 0;
        if (f <= 0) {
          this.rhNodeBaseline[i] = -128;
          continue;
        }
        const v = Math.max(0, Math.min(255, Math.round(snap.slotRssi[i] ?? 0)));
        dbm[i] = v;
        const crossing = Boolean(snap.crossingFlag[i]) || v >= (snap.nodeEnterLevels[i] ?? 90);
        hits[i] = crossing ? 1 : 0;
        const prevBase = this.rhNodeBaseline[i];
        if (prevBase <= -127) {
          this.rhNodeBaseline[i] = v;
        } else if (v < prevBase) {
          this.rhNodeBaseline[i] = prevBase + (v - prevBase) * 0.35;
        } else if (!crossing) {
          this.rhNodeBaseline[i] = prevBase + (v - prevBase) * 0.05;
        }
        floor[i] = Math.max(0, Math.min(255, Math.round(this.rhNodeBaseline[i])));
      }
      const sweepHz = this.activeSweepHz();
      const sample: LiveSample = {
        n: ++this.rhSampleSeq,
        us: Math.round(1_000_000 / sweepHz),
        dbm,
        pk: [...dbm],
        floor,
        hits,
      };
      this.live = sample;
      this.liveCount++;
      this.signalRing.push(sample, sweepHz, 2);
      this.recordRhFindingFromSample(snap, sample);
      this.updateLive();
      const sigNoteEl = this.el.querySelector<HTMLElement>("[data-signal-head-note]");
      if (sigNoteEl && this.signalEndN === null) {
        sigNoteEl.textContent = `Streaming · ~${sweepHz} Hz ${isUSB ? "USB serial poll" : "Socket.IO heartbeat"} · ${snap.heartbeatsRx} frames`;
      }
      const sigClearBtn = this.el.querySelector<HTMLButtonElement>("[data-signal-clear-btn]");
      if (sigClearBtn && sigClearBtn.disabled) {
        sigClearBtn.disabled = false;
      }
      if (this.signalEndN === null && !this.signalDrag) {
        this.dirtySignal = true;
        this.dirtyNoiseTable = true;
      }
    }

    if (now - this.rhLastHealthPushAt >= 2000 || this.rhHealthHistory.points.length === 0) {
      this.rhLastHealthPushAt = now;
      const nodeCount = snap.nodeCount === 4 ? 4 : 8;
      let sumBase = 0;
      let cntBase = 0;
      for (let i = 0; i < nodeCount; i++) {
        const f = snap.nodeFreqsMhz[i] ?? 0;
        if (f <= 0) continue;
        const base = this.rhNodeBaseline[i] > -127 ? this.rhNodeBaseline[i] : (snap.slotRssi[i] ?? 0);
        sumBase += base;
        cntBase++;
      }
      const meanBase = cntBase > 0 ? sumBase / cntBase : 0;
      this.rhHealthHistory.push(Math.abs(snap.clockOffsetMs), meanBase, snap.passesRx, snap.heartbeatsRx, 10);
      this.dirtyHealth = true;
    }
  }

  private stopActiveStreamsOn(target: TimerConsole): void {
    if (!target.connected) return;
    const cmds: string[] = [];
    if (this.liveOn) cmds.push("LIVE 0");
    if (this.scanLive || this.status?.scanLive) cmds.push("SCAN STOP");
    if (this.logOn) cmds.push("LOG 0");
    if (this.status?.freqsTemporary) cmds.push("CHANNELS RESET");
    if (!this.status?.emergencyMode) cmds.push("RF 1");
    if (cmds.length > 0) {
      void target.send(cmds.join("\n")).catch(() => undefined);
    }
  }

  private bindConsole(next: TimerConsole): void {
    if (this.unsubConsole && this.console !== next) {
      this.stopActiveStreamsOn(this.console);
      this.console.setBusyLabel(null);
    }
    this.unsubConsole?.();
    window.clearInterval(this.statusTimer);

    this.console = next;
    this.console.showAllPorts = this.showAllPorts;
    this.status = this.console.connected ? this.console.lastStatus : null;
    this.live = null;
    this.liveCount = 0;
    this.liveOn = false;
    this.logOn = false;
    this.scanning = false;
    this.scanLive = Boolean(this.status?.scanLive);
    this.checks = [];
    this.checksAt = null;
    this.reportExtra = "";
    this.bootLog = null;
    this.logLines = [];
    this.serialLines = [];
    this.signalRing.clear();
    this.healthHistory.clear();
    this.spectrumAcc.clearAll();
    this.signalFindings = [];
    this.signalFindingSeq = 0;
    this.scanFindings = [];
    this.scanFindingSeq = 0;

    this.unsubConsole = this.console.subscribe({
      onConnect: () => {
        this.signalRing.clear();
        this.healthHistory.clear();
        this.signalFindings = [];
        this.signalFindingSeq = 0;
        this.scanFindings = [];
        this.scanFindingSeq = 0;
        this.renderAll();
        void this.startSession();
      },
      onStatus: (s) => {
        const firstStatus = this.status === null;
        const freqsChanged = this.status?.freqs.join() !== s.freqs.join();
        const rfChanged = this.status?.rf.enabled !== s.rf.enabled;
        const emergencyChanged = Boolean(this.status?.emergencyMode) !== Boolean(s.emergencyMode);
        this.status = s;
        let maskChanged = false;
        if (s.chanMask !== undefined && Date.now() - this.chanMaskToggledAt > 1500) {
          const nextEnabled = Array.from({ length: 8 }, (_, i) => ((s.chanMask! >> i) & 1) !== 0);
          if (nextEnabled.join() !== this.signalEnabledCh.join()) {
            this.signalEnabledCh = nextEnabled;
            maskChanged = true;
          }
        }
        if (s.emergencyMode) {
          this.liveOn = false;
          this.scanLive = false;
        }
        let scanChanged = false;
        if (!s.emergencyMode && s.scanLive !== undefined && s.scanLive !== this.scanLive && Date.now() - this.scanToggleAt > 3000) {
          this.scanLive = s.scanLive;
          scanChanged = true;
        }
        this.renderConnection();
        this.renderStatus();
        this.renderNetworkView();
        this.renderLiveHead();
        if (firstStatus || emergencyChanged || freqsChanged || rfChanged || scanChanged || maskChanged) {
          if (freqsChanged) this.renderLive();
          else if (maskChanged) this.updateLive();
          if (!this.channelsDirty) this.renderChannels();
          this.renderSelfTest();
          this.renderSignalControls();
          this.renderScan();
          this.renderLog();
          this.renderSerialConsole();
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
        if (this.signalEndN === null && !this.signalDrag) {
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
        }
      },
      onScan: (s) => {
        if (s.live && !this.scanLive) return;
        this.ingestScanPassResult(s);
        if (!s.live) {
          void this.syncRfState();
        }
      },
      onLog: (line) => this.appendLog(line),
      onRawReply: (line, msgType) => {
        if (msgType === "status") {
          if (!this.serialExpectStatus) return;
          this.serialExpectStatus = false;
        }
        if (msgType === "ok" || msgType === "err" || Date.now() < this.serialAwaitUntil) {
          if (msgType === "bootlog") {
            try {
              const bl = JSON.parse(line.slice(1)) as BootLog;
              this.appendSerialLine(`--- ${bl.which} boot log (boot #${bl.boots}, reset: ${bl.reset}) ---`);
              for (const l of (bl.text || "(empty)").split("\n")) {
                this.appendSerialLine(l);
              }
              return;
            } catch {
              // fall through
            }
          }
          if (msgType !== "live") {
            this.appendSerialLine(line);
          }
        }
      },
      onConfig: (c) => {
        const line = `[config] ${c.role} "${c.timerLabel}" fp=${c.fingerprint} fw=${c.firmwareVersion} ch=${c.frequenciesMHz.join(",")}`;
        this.appendLog(line);
        this.renderNetworkView();
        if (Date.now() < this.serialAwaitUntil) {
          this.appendSerialLine(line);
        }
      },
      onError: (msg) => {
        this.error = msg;
        this.scanning = false;
        this.renderConnection();
        this.renderScan();
      },
      onDisconnect: () => {
        window.clearInterval(this.statusTimer);
        if (this.console.reconnecting) {
          this.resumeLiveAfterReconnect = this.liveOn;
          this.resumeScanLiveAfterReconnect = this.scanLive;
        } else {
          this.resumeLiveAfterReconnect = false;
          this.resumeScanLiveAfterReconnect = false;
        }
        this.status = null;
        this.liveOn = false;
        this.logOn = false;
        this.scanLive = false;
        this.renderAll();
      },
    });

    this.renderAll();
    if (this.console.connected) {
      void this.startSession();
    }
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

  /**
   * Make sure the 5.8 GHz receiver is on (RF 1) for Debug view operations: streaming monitored
   * channels, spectrum scans, and the self-test.
   *
   * It never switches the receiver off on its own. The receiver is the timer's lap detector: an
   * automatic standby when the Debug page went idle left the Hub or Spoke deaf (no RSSI, no laps,
   * flat bars on the Network page) until something sent RF 1 again.
   */
  private async syncRfState(_forceOn?: boolean): Promise<void> {
    if (!this.console.connected || this.status?.emergencyMode) return;
    const wantOn = true;
    if (this.status && this.status.rf.enabled === wantOn) return;
    await this.console.request(`RF ${wantOn ? 1 : 0}`, "ok", 2000).catch(() => undefined);
    if (this.status) {
      this.status.rf.enabled = wantOn;
    }
    this.renderStatus();
  }

  /** Push the active 8-channel monitoring bitmask to the timer over USB so unchecked slots are skipped in hardware sweeps. */
  private syncChannelMaskToFirmware(): void {
    let mask = 0;
    for (let i = 0; i < 8; i++) {
      if (this.signalEnabledCh[i]) mask |= 1 << i;
    }
    this.chanMaskToggledAt = Date.now();
    if (this.status) {
      this.status.chanMask = mask;
    }
    if (this.console.connected && !this.status?.emergencyMode && !this.scanLive) {
      void this.console.send(`CHANNELS MASK ${mask}`).catch(() => undefined);
    }
  }

  private signalViewEndN(): number {
    if (this.signalEndN !== null) return this.signalEndN;
    if (this.signalDrag) return this.signalDrag.startEndN;
    return this.signalRing.latestN();
  }

  private clampSignalEndN(endN: number): number {
    const latest =
      this.signalEndN !== null && this.signalRefN > 0
        ? this.signalRefN
        : this.signalDrag
          ? this.signalDrag.startEndN
          : this.signalRing.latestN();
    const earliest = this.signalRing.earliestN();
    const sweepHz = this.activeSweepHz();
    const windowSweeps = this.signalWindowSec * sweepHz;
    const minEnd = earliest;
    const maxEnd = Math.max(latest, earliest + windowSweeps);
    return Math.min(maxEnd, Math.max(minEnd, endN));
  }

  private pauseSignalAt(endN: number): void {
    const wasLive = this.signalEndN === null;
    if (wasLive) {
      this.signalRefN = this.signalDrag ? this.signalDrag.startEndN : this.signalRing.latestN();
      this.signalEndN = this.signalRefN;
    }
    this.signalEndN = this.clampSignalEndN(endN);
    if (wasLive) {
      this.renderSignalControls();
    }
  }

  private currentScanBounds(): { vStart: number; vStop: number } {
    const s = this.spectrumAcc.latest;
    const maxStop = this.scanYBounds().maxFreqMHz;
    const rawStart = this.scanStartMHz;
    const rawStop = this.scanStopMHz;
    const rawStep = Math.max(1, this.scanStepMHz);
    const fullStart = s && s.dbm.length ? s.start : Math.max(5180, Math.min(5900, rawStart));
    const fullStop =
      s && s.dbm.length
        ? s.start + s.step * (s.dbm.length - 1)
        : Math.max(fullStart + rawStep, Math.min(maxStop, rawStop));
    const step = s && s.dbm.length ? s.step : rawStep;
    const vStart = this.scanZoomStartMHz ?? fullStart;
    const vStop = Math.max(vStart + step, this.scanZoomStopMHz ?? fullStop);
    return { vStart, vStop };
  }

  private applyFreqZoomFromBox(box: { x0: number; x1: number }, plotW: number, L = 44): void {
    const b = this.currentScanBounds();
    const s = this.spectrumAcc.latest;
    const step = s && s.dbm.length ? s.step : Math.max(1, this.scanStepMHz);
    const xa = Math.max(L, Math.min(L + plotW, Math.min(box.x0, box.x1)));
    const xb = Math.max(L, Math.min(L + plotW, Math.max(box.x0, box.x1)));
    if (xb - xa < 12) return;
    const span = b.vStop - b.vStart;
    const f0 = b.vStart + ((xa - L) / plotW) * span;
    const f1 = b.vStart + ((xb - L) / plotW) * span;
    if (f1 - f0 >= Math.max(10, step * 2)) {
      this.scanZoomStartMHz = f0;
      this.scanZoomStopMHz = f1;
      this.renderScan();
    }
  }

  private applyFreqStretch(startMHz0: number, startMHz1: number, anchorFrac: number, factor: number): void {
    const s = this.spectrumAcc.latest;
    const maxStop = this.scanYBounds().maxFreqMHz;
    const rawStart = this.scanStartMHz;
    const rawStop = this.scanStopMHz;
    const rawStep = Math.max(1, this.scanStepMHz);
    const fullStart = s && s.dbm.length ? s.start : Math.max(5180, Math.min(5900, rawStart));
    const fullStop =
      s && s.dbm.length
        ? s.start + s.step * (s.dbm.length - 1)
        : Math.max(fullStart + rawStep, Math.min(maxStop, rawStop));
    const step = s && s.dbm.length ? s.step : rawStep;
    const fullSpan = Math.max(10, fullStop - fullStart);
    const curSpan = Math.max(10, startMHz1 - startMHz0);
    const minSpan = Math.max(10, step * 3);
    const nextSpan = Math.max(minSpan, Math.min(fullSpan, curSpan * factor));
    const anchorMHz = startMHz0 + anchorFrac * curSpan;
    let f0 = anchorMHz - anchorFrac * nextSpan;
    let f1 = f0 + nextSpan;
    const minF0 = fullStart;
    const maxF1 = fullStop;
    if (f0 < minF0) {
      f0 = minF0;
      f1 = f0 + nextSpan;
    }
    if (f1 > maxF1) {
      f1 = maxF1;
      f0 = f1 - nextSpan;
    }
    if (Math.abs(f0 - fullStart) <= 0.5 && Math.abs(f1 - fullStop) <= 0.5) {
      this.scanZoomStartMHz = null;
      this.scanZoomStopMHz = null;
    } else {
      this.scanZoomStartMHz = f0;
      this.scanZoomStopMHz = f1;
    }
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
    this.updateScanFindings();
  }

  private applyFreqPan(startMHz0: number, startMHz1: number, deltaMHz: number): void {
    const s = this.spectrumAcc.latest;
    const maxStop = this.scanYBounds().maxFreqMHz;
    const rawStart = this.scanStartMHz;
    const rawStop = this.scanStopMHz;
    const fullStart = s && s.dbm.length ? s.start : Math.max(5180, Math.min(5900, rawStart));
    const fullStop = s && s.dbm.length ? s.start + s.step * (s.dbm.length - 1) : Math.max(fullStart + 5, Math.min(maxStop, rawStop));
    const span = Math.max(10, Math.min(fullStop - fullStart, startMHz1 - startMHz0));
    let f0 = startMHz0 + deltaMHz;
    let f1 = f0 + span;
    const minF0 = fullStart;
    const maxF1 = fullStop;
    if (f0 < minF0) {
      f0 = minF0;
      f1 = f0 + span;
    }
    if (f1 > maxF1) {
      f1 = maxF1;
      f0 = f1 - span;
    }
    if (Math.abs(f0 - fullStart) <= 0.5 && Math.abs(f1 - fullStop) <= 0.5) {
      this.scanZoomStartMHz = null;
      this.scanZoomStopMHz = null;
    } else {
      this.scanZoomStartMHz = f0;
      this.scanZoomStopMHz = f1;
    }
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
    this.updateScanFindings();
  }

  private applyDbmStretch(
    startMin: number,
    startMax: number,
    anchorFrac: number,
    factor: number,
    target: "signal" | "scan"
  ): void {
    const sb = this.scanYBounds();
    const bMin = target === "signal" ? this.signalYBounds().min : sb.min;
    const bMax = target === "signal" ? this.signalYBounds().max : sb.max;
    const minAllow = target === "signal" ? 4 : sb.rssiScale ? 12 : 4;
    const curSpan = Math.max(minAllow, startMax - startMin);
    const nextSpan = Math.max(minAllow, Math.min(bMax - bMin, curSpan * factor));
    const anchorDbm = startMin + anchorFrac * curSpan;
    let nextMin = anchorDbm - anchorFrac * nextSpan;
    let nextMax = nextMin + nextSpan;
    if (nextMin < bMin) {
      nextMin = bMin;
      nextMax = Math.min(bMax, bMin + nextSpan);
    }
    if (nextMax > bMax) {
      nextMax = bMax;
      nextMin = Math.max(bMin, bMax - nextSpan);
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
      this.syncScanColorRange();
      this.dirtySpectrum = true;
      this.dirtyWaterfall = true;
    }
  }

  private applyDbmPan(startMin: number, startMax: number, deltaDbm: number, target: "signal" | "scan"): void {
    const sb = this.scanYBounds();
    const bMin = target === "signal" ? this.signalYBounds().min : sb.min;
    const bMax = target === "signal" ? this.signalYBounds().max : sb.max;
    const minAllow = target === "signal" ? 4 : sb.rssiScale ? 12 : 4;
    const span = Math.max(minAllow, startMax - startMin);
    let nextMin = startMin + deltaDbm;
    let nextMax = nextMin + span;
    if (nextMin < bMin) {
      nextMin = bMin;
      nextMax = Math.min(bMax, bMin + span);
    }
    if (nextMax > bMax) {
      nextMax = bMax;
      nextMin = Math.max(bMin, bMax - span);
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
      this.syncScanColorRange();
      this.dirtySpectrum = true;
      this.dirtyWaterfall = true;
    }
  }

  private updateAutoSignalAxes(canvasWidth: number): void {
    const isRH = this.isRotorHazardMode();
    const sweepHz = this.activeSweepHz();
    const yb = this.signalYBounds();
    const ptsAll = this.signalRing.points;

    if (this.signalAutoX) {
      let effectiveRateHz = isRH ? sweepHz : this.liveMode === 2 ? sweepHz : Math.max(1, Math.round(sweepHz / 5));
      if (ptsAll.length >= 12) {
        const a = ptsAll[Math.max(0, ptsAll.length - 30)];
        const b = ptsAll[ptsAll.length - 1];
        const dtSec = (b.tMs - a.tMs) / 1000;
        const count = ptsAll.length - 1 - Math.max(0, ptsAll.length - 30);
        if (dtSec >= 0.15 && dtSec <= 5 && count >= 5) {
          effectiveRateHz = Math.max(4, Math.min(sweepHz, count / dtSec));
        }
      }
      const plotW = Math.max(240, (canvasWidth || 700) - 36);
      const targetSamples = Math.max(200, Math.min(900, Math.round(plotW * 1.15)));
      const rawSec = targetSamples / Math.max(4, effectiveRateHz);
      const snappedSec = Math.max(15, Math.min(30, Math.round(rawSec)));
      if (Math.abs(this.signalWindowSec - snappedSec) >= 0.4) {
        this.signalWindowSec = snappedSec;
      }
    }

    if (this.signalAutoY) {
      const effectiveEndN = this.signalEndN ?? (this.signalDrag ? this.signalDrag.startEndN : null);
      const effectiveCapN =
        this.signalEndN !== null ? this.signalRefN : this.signalDrag ? this.signalDrag.startEndN : null;
      const pts = this.signalRing.windowPoints(this.signalWindowSec, sweepHz, effectiveEndN, 0, effectiveCapN);
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
              if (!isRH && this.signalShowHitLine && fl + 10 > maxD) {
                maxD = fl + 10;
              }
            }
          }
        }
        if (this.signalShowThresholds && maxD > -1000) {
          if (isRH) {
            const snap = this.activeRhSnapshot();
            if (snap) {
              const nCount = snap.nodeCount === 4 ? 4 : 8;
              for (let ch = 0; ch < nCount; ch++) {
                if (!this.signalEnabledCh[ch]) continue;
                if ((snap.nodeFreqsMhz[ch] ?? 0) <= 0) continue;
                const enterAt = snap.nodeEnterLevels[ch] ?? 90;
                const exitAt = snap.nodeExitLevels[ch] ?? 70;
                if (enterAt + 8 > maxD) maxD = enterAt + 8;
                if (exitAt - 6 < minD) minD = Math.max(0, exitAt - 6);
              }
            }
          } else {
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
        }
        if (minD <= maxD) {
          const padLow = isRH ? 8 : 4;
          const padHigh = isRH ? 12 : 5;
          const stepSnap = isRH ? 5 : 2;
          let targetMin = Math.max(yb.min, Math.floor((minD - padLow) / stepSnap) * stepSnap);
          let targetMax = Math.min(yb.max, Math.ceil((maxD + padHigh) / stepSnap) * stepSnap);
          const minSpan = yb.minSpan;
          if (targetMax - targetMin < minSpan) {
            const extra = minSpan - (targetMax - targetMin);
            targetMin = Math.max(yb.min, targetMin - Math.floor(extra * 0.35));
            targetMax = Math.min(yb.max, targetMin + minSpan);
          }
          if (this.signalSmoothYMin === null || this.signalSmoothYMax === null) {
            this.signalSmoothYMin = targetMin;
            this.signalSmoothYMax = targetMax;
          } else {
            const curMin = this.signalSmoothYMin;
            const curMax = this.signalSmoothYMax;
            const marginLo = isRH ? 5 : 2;
            const marginHi = isRH ? 18 : 9;
            const needMinMove = minD < curMin + marginLo || minD > curMin + marginHi;
            const needMaxMove = maxD > curMax - marginLo || maxD < curMax - marginHi;
            const effTargetMin = needMinMove ? targetMin : curMin;
            const effTargetMax = needMaxMove ? targetMax : curMax;
            const diffMin = effTargetMin - curMin;
            const diffMax = effTargetMax - curMax;
            if (Math.abs(diffMin) > 0.05) {
              if (diffMin < 0) {
                this.signalSmoothYMin = effTargetMin;
              } else {
                this.signalSmoothYMin = Math.abs(diffMin) < 0.25 ? effTargetMin : curMin + diffMin * 0.08;
              }
            }
            if (Math.abs(diffMax) > 0.05) {
              if (diffMax > 0) {
                // Expand upward immediately so rising RF peaks are never chopped off by smoothing lag
                this.signalSmoothYMax = effTargetMax;
              } else {
                this.signalSmoothYMax = Math.abs(diffMax) < 0.25 ? effTargetMax : curMax + diffMax * 0.08;
              }
            }
          }
          this.signalYMin = this.signalSmoothYMin;
          this.signalYMax = Math.max(this.signalYMin + (isRH ? 24 : 12), this.signalSmoothYMax);
        }
      }
    }
  }

  private updateAutoScanY(): void {
    if (!this.scanAutoY) return;
    const s = this.spectrumAcc.latest;
    if (!s || !s.dbm.length) return;
    const sb = this.scanYBounds();
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
      if (sb.rssiScale && v <= 0) continue;
      if (v < minD) minD = v;
      if (v > maxD) maxD = v;
      if (hold && hold[i] > maxD && (!sb.rssiScale || hold[i] > 0)) maxD = hold[i];
    }
    if (minD <= maxD) {
      const padLo = sb.rssiScale ? 8 : 4;
      const padHi = sb.rssiScale ? 16 : 6;
      const minSpan = sb.rssiScale ? 45 : 20;
      let targetMin = Math.max(sb.min, minD - padLo);
      let targetMax = Math.min(sb.max, maxD + padHi);
      if (targetMax - targetMin < minSpan) {
        targetMax = Math.min(sb.max, targetMin + minSpan);
      }
      this.scanYMin = targetMin;
      this.scanYMax = targetMax;
      if (sb.rssiScale) {
        const cMin = Math.max(0, Math.round(minD - 3));
        const cMax = Math.max(cMin + 24, Math.min(255, Math.round(maxD + 16)));
        this.spectrumAcc.setColorRange(cMin, cMax, true);
      } else {
        this.spectrumAcc.setColorRange(this.scanYMin, Math.min(-25, this.scanYMax + 6), false);
      }
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

    this.listen(window as unknown as HTMLElement, "pointerdown", (e: PointerEvent) => {
      if (!this.openAxisMenu) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-axis-pill]")) return;
      const prev = this.openAxisMenu;
      this.openAxisMenu = null;
      if (prev === "signal-x" || prev === "signal-y") {
        this.renderSignalControls();
      } else {
        this.renderScan();
      }
    });

    type DebugCanvasKind = "signal" | "spectrum" | "waterfall";
    const resolveDebugCanvasKind = (el: Element | null): DebugCanvasKind | null => {
      if (!el || !el.matches) return null;
      if (el.matches("[data-signal-canvas]")) return "signal";
      if (el.matches("[data-spectrum-canvas]")) return "spectrum";
      if (el.matches("[data-waterfall-canvas]")) return "waterfall";
      return null;
    };

    const resetDebugCanvasAxes = (kind: DebugCanvasKind) => {
      if (kind === "signal") {
        this.signalEndN = null;
        this.signalAutoX = true;
        this.signalAutoY = true;
        this.signalSmoothYMin = null;
        this.signalSmoothYMax = null;
        this.renderSignalControls();
        this.dirtySignal = true;
        this.dirtyNoiseTable = true;
      } else {
        const sb = this.scanYBounds();
        this.scanZoomStartMHz = null;
        this.scanZoomStopMHz = null;
        this.scanAutoY = false;
        this.scanYMin = sb.min;
        this.scanYMax = sb.max;
        this.syncScanColorRange();
        this.spectrumAcc.setVisibleRows(80);
        this.renderScan();
      }
      this.saveDebugPrefs();
    };

    const onDebugWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      const kind = resolveDebugCanvasKind(target);
      if (!kind || !target) return;
      const wf = computeWheelZoomFactors(e);
      if (!wf) return;
      e.preventDefault();

      const r = target.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const T = 12;
      const L = 32;
      const rightPad = kind === "waterfall" ? 14 : 4;
      const plotW = Math.max(10, r.width - L - rightPad);
      const plotH = Math.max(10, r.height - T - 26);
      const xFrac = Math.max(0, Math.min(1, (x - L) / plotW));
      const yFrac = Math.max(0, Math.min(1, 1 - (y - T) / plotH));

      if (kind === "signal") {
        if (wf.mode === "x" || wf.mode === "xy") {
          const prevSec = this.signalWindowSec;
          const prevEndN = this.signalViewEndN();
          const nextSec = Math.max(0.4, Math.min(120, prevSec * wf.xSpanFactor));
          this.signalAutoX = false;
          this.signalWindowSec = nextSec;
          if (this.signalEndN !== null) {
            const sweepHz = this.activeSweepHz();
            const anchorN = prevEndN - (1 - xFrac) * prevSec * sweepHz;
            this.signalEndN = this.clampSignalEndN(anchorN + (1 - xFrac) * nextSec * sweepHz);
          }
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
        }
        if (wf.mode === "y" || wf.mode === "xy") {
          this.applyDbmStretch(this.signalYMin, this.signalYMax, yFrac, wf.ySpanFactor, "signal");
        }
        this.renderSignalControls();
      } else if (kind === "spectrum") {
        const bounds = this.currentScanBounds();
        if (bounds && (wf.mode === "x" || wf.mode === "xy")) {
          this.applyFreqStretch(bounds.vStart, bounds.vStop, xFrac, wf.xSpanFactor);
        }
        if (wf.mode === "y" || wf.mode === "xy") {
          this.applyDbmStretch(this.scanYMin, this.scanYMax, yFrac, wf.ySpanFactor, "scan");
        }
        this.renderScan();
      } else {
        const bounds = this.currentScanBounds();
        if (bounds && (wf.mode === "x" || wf.mode === "xy")) {
          this.applyFreqStretch(bounds.vStart, bounds.vStop, xFrac, wf.xSpanFactor);
        }
        if (wf.mode === "y" || wf.mode === "xy") {
          this.spectrumAcc.setVisibleRows(this.spectrumAcc.visibleRows * wf.ySpanFactor);
          this.updateScanFindings();
          this.dirtyWaterfall = true;
        }
        this.renderScan();
      }
      this.saveDebugPrefs();
    };
    this.el.addEventListener("wheel", onDebugWheel, { passive: false });
    this.onDispose(() => this.el.removeEventListener("wheel", onDebugWheel));

    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let lastTapKind: DebugCanvasKind | "" = "";
    let tapCandidate: {
      pointerId: number;
      kind: DebugCanvasKind;
      startX: number;
      startY: number;
      startMs: number;
      moved: boolean;
    } | null = null;

    const debugTouchPts = new Map<
      number,
      { kind: DebugCanvasKind; x: number; y: number; clientX: number; clientY: number }
    >();
    let debugPinch: {
      kind: DebugCanvasKind;
      id1: number;
      id2: number;
      p1Start: PinchPoint;
      p2Start: PinchPoint;
      p1ClientStart: PinchPoint;
      p2ClientStart: PinchPoint;
      lastMidClientY: number;
      pageScrollLocked: boolean;
      pinchLocked: boolean;
      wasSignalLive: boolean;
      startEndN: number;
      startWindowSec: number;
      startYMin: number;
      startYMax: number;
      startMHz0: number;
      startMHz1: number;
      startScrollRow: number;
      startVisibleRows: number;
      anchorXFrac: number;
      anchorYFrac: number;
    } | null = null;

    this.listen(this.el, "pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const target = e.target as HTMLElement;
      const isTouch = e.pointerType === "touch";
      const canvasKind = resolveDebugCanvasKind(target);

      if (isTouch && canvasKind) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {}
        const r = target.getBoundingClientRect();
        const lx = e.clientX - r.left;
        const ly = e.clientY - r.top;
        debugTouchPts.set(e.pointerId, {
          kind: canvasKind,
          x: lx,
          y: ly,
          clientX: e.clientX,
          clientY: e.clientY,
        });

        const allTouchPts = Array.from(debugTouchPts.entries());
        const sameKindPts = allTouchPts.filter(([, v]) => v.kind === canvasKind);
        if (allTouchPts.length === 1) {
          tapCandidate = {
            pointerId: e.pointerId,
            kind: canvasKind,
            startX: e.clientX,
            startY: e.clientY,
            startMs: performance.now(),
            moved: false,
          };
        } else {
          tapCandidate = null;
          lastTapTime = 0;
        }

        if (allTouchPts.length >= 2) {
          this.signalDrag = null;
          this.signalYZoomBox = null;
          this.specDragging = null;
          this.wfDragging = null;
          this.scanZoomBox = null;
          const pairPts = sameKindPts.length >= 2 ? sameKindPts : allTouchPts;
          const crossCanvas = sameKindPts.length < 2;
          const [[id1, pt1], [id2, pt2]] = pairPts;
          const midX = (pt1.x + pt2.x) * 0.5;
          const midY = (pt1.y + pt2.y) * 0.5;
          const T = 12;
          const L = 32;
          const rightPad = canvasKind === "waterfall" ? 14 : 4;
          const plotW = Math.max(10, r.width - L - rightPad);
          const plotH = Math.max(10, r.height - T - 26);
          const bounds = this.currentScanBounds();
          debugPinch = {
            kind: canvasKind,
            id1,
            id2,
            p1Start: { x: pt1.x, y: pt1.y },
            p2Start: { x: pt2.x, y: pt2.y },
            p1ClientStart: { x: pt1.clientX, y: pt1.clientY },
            p2ClientStart: { x: pt2.clientX, y: pt2.clientY },
            lastMidClientY: (pt1.clientY + pt2.clientY) * 0.5,
            pageScrollLocked: crossCanvas,
            pinchLocked: false,
            wasSignalLive: this.signalEndN === null,
            startEndN: this.signalViewEndN(),
            startWindowSec: this.signalWindowSec,
            startYMin: canvasKind === "signal" ? this.signalYMin : this.scanYMin,
            startYMax: canvasKind === "signal" ? this.signalYMax : this.scanYMax,
            startMHz0: bounds ? bounds.vStart : this.scanStartMHz,
            startMHz1: bounds ? bounds.vStop : this.scanStopMHz,
            startScrollRow: this.spectrumAcc.scrollRow,
            startVisibleRows: this.spectrumAcc.visibleRows,
            anchorXFrac: Math.max(0, Math.min(1, (midX - L) / plotW)),
            anchorYFrac: Math.max(0, Math.min(1, 1 - (midY - T) / plotH)),
          };
          return;
        }
      }

      const yAxisW = isTouch ? 44 : 36;
      const xAxisH = isTouch ? 36 : 26;
      const sbW = isTouch ? 32 : 24;

      if (target.matches("[data-signal-canvas]")) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {}
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        this.signalHover = { x, y };
        this.dirtySignal = true;
        const T = 12;
        const L = 32;
        const plotH = Math.max(10, r.height - T - 26);
        const plotW = Math.max(10, r.width - L - 4);
        if (x < yAxisW) {
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
        } else if (y >= r.height - xAxisH && x >= L) {
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
        try {
          target.setPointerCapture(e.pointerId);
        } catch {}
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        this.scanHover = { x, y };
        this.dirtySpectrum = true;
        const T = 12;
        const L = 32;
        const plotH = Math.max(10, r.height - T - 26);
        const plotW = Math.max(10, r.width - L - 4);
        const bounds = this.currentScanBounds();
        if (!bounds) return;
        if (x < yAxisW) {
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
        } else if (y >= r.height - xAxisH && x >= L) {
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
        } else if (x >= L && x <= r.width - 4) {
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
        try {
          target.setPointerCapture(e.pointerId);
        } catch {}
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        this.waterfallHover = { x, y };
        this.dirtyWaterfall = true;
        const L = 32;
        const plotW = Math.max(10, r.width - L - 14);
        const bounds = this.currentScanBounds();
        if (x < yAxisW) {
          // Dragging on Waterfall Y-axis stretches/shrinks vertical time scale (visibleRows)
          this.wfDragging = {
            mode: "ystretch",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
            startVisibleRows: this.spectrumAcc.visibleRows,
            startMHz0: bounds.vStart,
            startMHz1: bounds.vStop,
            anchorFrac: 0,
          };
        } else if (y >= r.height - xAxisH && x >= L) {
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
        } else if (x >= r.width - sbW && this.spectrumAcc.maxScrollRow() > 0) {
          this.wfDragging = {
            mode: "scrollbar",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
            startVisibleRows: this.spectrumAcc.visibleRows,
            startMHz0: bounds.vStart,
            startMHz1: bounds.vStop,
            anchorFrac: 0,
          };
          scrubScrollbar(target, e.clientY);
        } else if (x >= L && x < r.width - 14) {
          if (e.shiftKey) {
            this.wfDragging = {
              mode: "zoom",
              startX: x,
              startY: e.clientY,
              startScroll: this.spectrumAcc.scrollRow,
              startVisibleRows: this.spectrumAcc.visibleRows,
              startMHz0: bounds.vStart,
              startMHz1: bounds.vStop,
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
              startMHz0: bounds.vStart,
              startMHz1: bounds.vStop,
              anchorFrac: 0.5,
            };
          }
        }
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerType === "touch" && debugTouchPts.has(e.pointerId)) {
        const endedEntry = debugTouchPts.get(e.pointerId)!;
        const wasSingleCleanTap =
          e.type === "pointerup" &&
          debugPinch === null &&
          debugTouchPts.size === 1 &&
          tapCandidate !== null &&
          tapCandidate.pointerId === e.pointerId &&
          !tapCandidate.moved &&
          performance.now() - tapCandidate.startMs < 300;
        tapCandidate = null;
        debugTouchPts.delete(e.pointerId);

        if (wasSingleCleanTap) {
          const now = performance.now();
          if (
            lastTapKind === endedEntry.kind &&
            now - lastTapTime < 340 &&
            Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 32
          ) {
            lastTapTime = 0;
            this.signalDrag = null;
            this.specDragging = null;
            this.wfDragging = null;
            resetDebugCanvasAxes(endedEntry.kind);
            return;
          }
          lastTapTime = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
          lastTapKind = endedEntry.kind;
        }

        if (debugPinch !== null) {
          const remSame = Array.from(debugTouchPts.values()).filter((v) => v.kind === debugPinch!.kind);
          if (debugTouchPts.size < 2) {
            const finishedKind = debugPinch.kind;
            const wasPageScroll = debugPinch.pageScrollLocked;
            debugPinch = null;
            if (finishedKind === "signal") {
              this.renderSignalControls();
              this.dirtySignal = true;
            } else {
              this.renderScan();
            }
            this.saveDebugPrefs();
            if (remSame.length === 1 && !wasPageScroll) {
              const rem = remSame[0];
              if (finishedKind === "signal") {
                this.signalDrag = {
                  mode: "pan",
                  startX: rem.x,
                  startY: rem.y,
                  startEndN: this.signalViewEndN(),
                  startWindowSec: this.signalWindowSec,
                  startYMin: this.signalYMin,
                  startYMax: this.signalYMax,
                  anchorFrac: 0.5,
                };
              } else if (finishedKind === "spectrum") {
                const bounds = this.currentScanBounds();
                if (bounds) {
                  this.specDragging = {
                    mode: "pan",
                    startX: rem.x,
                    startY: rem.y,
                    startYMin: this.scanYMin,
                    startYMax: this.scanYMax,
                    startMHz0: bounds.vStart,
                    startMHz1: bounds.vStop,
                    anchorFrac: 0.5,
                  };
                }
              } else {
                const bounds = this.currentScanBounds();
                if (bounds) {
                  this.wfDragging = {
                    mode: "pan",
                    startX: rem.x,
                    startY: rem.clientY,
                    startScroll: this.spectrumAcc.scrollRow,
                    startVisibleRows: this.spectrumAcc.visibleRows,
                    startMHz0: bounds.vStart,
                    startMHz1: bounds.vStop,
                    anchorFrac: 0.5,
                  };
                }
              }
            }
          }
          return;
        }
      }

      const hadDrag = Boolean(this.signalDrag || this.specDragging || this.wfDragging);
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
                const yb2 = this.signalYBounds();
                this.signalAutoY = false;
                this.signalYMin = Math.max(yb2.min, dLow);
                this.signalYMax = Math.min(yb2.max, dHigh);
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
          this.applyFreqZoomFromBox(this.scanZoomBox, Math.max(10, r.width - 32 - 4), 32);
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
            this.applyFreqZoomFromBox(this.scanZoomBox, Math.max(10, r.width - 32 - 14), 32);
          }
        } else if (this.wfDragging.mode === "ystretch" || this.wfDragging.mode === "xstretch" || this.wfDragging.mode === "pan") {
          this.renderScan();
        }
        this.wfDragging = null;
        this.scanZoomBox = null;
        this.dirtySpectrum = true;
        this.dirtyWaterfall = true;
      }
      if (hadDrag) {
        this.saveDebugPrefs();
      }
    };
    this.listen(window as unknown as HTMLElement, "pointerup", onPointerEnd);
    this.listen(window as unknown as HTMLElement, "pointercancel", onPointerEnd);

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
        this.saveDebugPrefs();
      } else if (target.matches("[data-spectrum-canvas], [data-waterfall-canvas]")) {
        const sb = this.scanYBounds();
        this.scanZoomStartMHz = null;
        this.scanZoomStopMHz = null;
        this.scanAutoY = false;
        this.scanYMin = sb.min;
        this.scanYMax = sb.max;
        this.syncScanColorRange();
        this.spectrumAcc.setVisibleRows(80);
        this.renderScan();
        this.saveDebugPrefs();
      } else {
        const chBtn = target.closest<HTMLElement>("[data-action='signal-ch']");
        if (chBtn) {
          const idx = Number(chBtn.dataset.ch);
          if (idx >= 0 && idx < 8) {
            const isSolo = this.signalEnabledCh[idx] && this.signalEnabledCh.filter(Boolean).length === 1;
            this.signalEnabledCh = this.signalEnabledCh.map((_, i) => (isSolo ? true : i === idx));
            this.syncChannelMaskToFirmware();
            this.updateLive();
            this.renderStatus();
            this.renderSignalControls();
            this.renderNoiseTable();
            this.dirtySignal = true;
            this.saveDebugPrefs();
          }
        }
      }
    });

    this.listen(window as unknown as HTMLElement, "pointermove", (e: PointerEvent) => {
      if (e.pointerType === "touch" && debugTouchPts.has(e.pointerId)) {
        const entry = debugTouchPts.get(e.pointerId)!;
        const canvasSelector =
          entry.kind === "signal"
            ? "[data-signal-canvas]"
            : entry.kind === "spectrum"
              ? "[data-spectrum-canvas]"
              : "[data-waterfall-canvas]";
        const canvasEl = this.el.querySelector<HTMLElement>(canvasSelector);
        if (canvasEl) {
          const r = canvasEl.getBoundingClientRect();
          const lx = e.clientX - r.left;
          const ly = e.clientY - r.top;
          debugTouchPts.set(e.pointerId, {
            kind: entry.kind,
            x: lx,
            y: ly,
            clientX: e.clientX,
            clientY: e.clientY,
          });
          if (
            tapCandidate &&
            tapCandidate.pointerId === e.pointerId &&
            Math.hypot(e.clientX - tapCandidate.startX, e.clientY - tapCandidate.startY) > 12
          ) {
            tapCandidate.moved = true;
          }

          if (debugPinch) {
            const p1 = debugTouchPts.get(debugPinch.id1);
            const p2 = debugTouchPts.get(debugPinch.id2);
            if (p1 && p2) {
              const clientPinch = computeDirectionalPinch(
                debugPinch.p1ClientStart,
                debugPinch.p2ClientStart,
                { x: p1.clientX, y: p1.clientY },
                { x: p2.clientX, y: p2.clientY }
              );
              const curMidClientY = (p1.clientY + p2.clientY) * 0.5;
              const dyClient = curMidClientY - debugPinch.lastMidClientY;
              debugPinch.lastMidClientY = curMidClientY;
              const d1y = p1.clientY - debugPinch.p1ClientStart.y;
              const d2y = p2.clientY - debugPinch.p2ClientStart.y;
              const bothMovedSameVert = (d1y > 4 && d2y > 4) || (d1y < -4 && d2y < -4);

              if (
                !debugPinch.pinchLocked &&
                (debugPinch.pageScrollLocked || (clientPinch.mode === "page-scroll" && bothMovedSameVert))
              ) {
                debugPinch.pageScrollLocked = true;
                scrollOuterPageBy(-dyClient, canvasEl);
                return;
              }
              const d0 = Math.hypot(
                debugPinch.p2ClientStart.x - debugPinch.p1ClientStart.x,
                debugPinch.p2ClientStart.y - debugPinch.p1ClientStart.y
              );
              const dNow = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
              if (Math.abs(dNow - d0) >= 14) {
                debugPinch.pinchLocked = true;
              }

              const pinch = computeDirectionalPinch(
                debugPinch.p1Start,
                debugPinch.p2Start,
                { x: p1.x, y: p1.y },
                { x: p2.x, y: p2.y }
              );
              if (pinch.mode === "page-scroll") {
                return;
              }
              const T = 12;
              const L = 32;
              const rightPad = debugPinch.kind === "waterfall" ? 14 : 4;
              const plotW = Math.max(10, r.width - L - rightPad);
              const plotH = Math.max(10, r.height - T - 26);

              if (debugPinch.kind === "signal") {
                if (pinch.mode === "x" || pinch.mode === "xy") {
                  this.signalAutoX = false;
                  const nextSec = Math.max(
                    0.4,
                    Math.min(120, debugPinch.startWindowSec * pinch.xSpanFactor)
                  );
                  const sweepHz = this.activeSweepHz();
                  this.signalWindowSec = nextSec;
                  if (!debugPinch.wasSignalLive) {
                    const liveXFrac = Math.max(0, Math.min(1, (pinch.midX - L) / plotW));
                    const anchorN =
                      debugPinch.startEndN -
                      (1 - debugPinch.anchorXFrac) * debugPinch.startWindowSec * sweepHz;
                    this.signalEndN = this.clampSignalEndN(anchorN + (1 - liveXFrac) * nextSec * sweepHz);
                  } else if (Math.abs(pinch.midX - pinch.startMidX) > 18) {
                    const deltaN = ((pinch.midX - pinch.startMidX) / plotW) * (nextSec * sweepHz);
                    this.pauseSignalAt(debugPinch.startEndN - deltaN);
                  }
                  this.dirtySignal = true;
                  this.dirtyNoiseTable = true;
                }
                if (pinch.mode === "y" || pinch.mode === "xy") {
                  this.applyDbmStretch(
                    debugPinch.startYMin,
                    debugPinch.startYMax,
                    debugPinch.anchorYFrac,
                    pinch.ySpanFactor,
                    "signal"
                  );
                  const dyMid = pinch.midY - pinch.startMidY;
                  if (Math.abs(dyMid) > 2) {
                    const curSpan = this.signalYMax - this.signalYMin;
                    this.applyDbmPan(this.signalYMin, this.signalYMax, (dyMid / plotH) * curSpan, "signal");
                  }
                }
              } else if (debugPinch.kind === "spectrum") {
                if (pinch.mode === "x" || pinch.mode === "xy") {
                  this.applyFreqStretch(
                    debugPinch.startMHz0,
                    debugPinch.startMHz1,
                    debugPinch.anchorXFrac,
                    pinch.xSpanFactor
                  );
                  const dxMid = pinch.midX - pinch.startMidX;
                  if (Math.abs(dxMid) > 2) {
                    const curBounds = this.currentScanBounds();
                    if (curBounds) {
                      const curSpan = curBounds.vStop - curBounds.vStart;
                      this.applyFreqPan(curBounds.vStart, curBounds.vStop, -(dxMid / plotW) * curSpan);
                    }
                  }
                }
                if (pinch.mode === "y" || pinch.mode === "xy") {
                  this.applyDbmStretch(
                    debugPinch.startYMin,
                    debugPinch.startYMax,
                    debugPinch.anchorYFrac,
                    pinch.ySpanFactor,
                    "scan"
                  );
                  const dyMid = pinch.midY - pinch.startMidY;
                  if (Math.abs(dyMid) > 2) {
                    const curSpan = this.scanYMax - this.scanYMin;
                    this.applyDbmPan(this.scanYMin, this.scanYMax, (dyMid / plotH) * curSpan, "scan");
                  }
                }
              } else {
                if (pinch.mode === "x" || pinch.mode === "xy") {
                  this.applyFreqStretch(
                    debugPinch.startMHz0,
                    debugPinch.startMHz1,
                    debugPinch.anchorXFrac,
                    pinch.xSpanFactor
                  );
                }
                if (pinch.mode === "y" || pinch.mode === "xy") {
                  this.spectrumAcc.setVisibleRows(debugPinch.startVisibleRows * pinch.ySpanFactor);
                  const dyMid = pinch.midY - pinch.startMidY;
                  if (Math.abs(dyMid) > 2) {
                    const pxPerRow = Math.max(1, (r.height - 30) / this.spectrumAcc.visibleRows);
                    this.spectrumAcc.setScrollRow(debugPinch.startScrollRow - dyMid / pxPerRow);
                  }
                  this.updateScanFindings();
                  this.dirtyWaterfall = true;
                }
              }
            }
            return;
          }
        }
      }

      const target = e.target as HTMLElement | null;
      if (this.signalDrag) {
        const sig = this.el.querySelector<HTMLElement>("[data-signal-canvas]");
        if (sig) {
          const r = sig.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const dx = x - this.signalDrag.startX;
          const dy = y - this.signalDrag.startY;
          const plotW = Math.max(10, r.width - 32 - 4);
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
            const sweepHz = this.activeSweepHz();
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
            if (Math.abs(dx) >= 2 || this.signalEndN !== null) {
              const sweepHz = this.activeSweepHz();
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
          const plotW = Math.max(10, r.width - 32 - 4);
          const plotH = Math.max(10, r.height - 12 - 26);
          const touchGesture = e.pointerType === "touch";
          if (this.specDragging.mode === "ystretch") {
            if (!touchGesture || (Math.abs(dy) >= 12 && Math.abs(dy) >= Math.abs(dx) * 1.15)) {
              const factor = Math.exp(dy / 140);
              this.applyDbmStretch(this.specDragging.startYMin, this.specDragging.startYMax, this.specDragging.anchorFrac, factor, "scan");
            }
          } else if (this.specDragging.mode === "xstretch") {
            if (!touchGesture || (Math.abs(dx) >= 12 && Math.abs(dx) >= Math.abs(dy) * 1.15)) {
              const factor = Math.exp(-dx / 150);
              this.applyFreqStretch(this.specDragging.startMHz0, this.specDragging.startMHz1, this.specDragging.anchorFrac, factor);
            }
          } else if (this.specDragging.mode === "zoom") {
            const clampedX = Math.max(32, Math.min(r.width - 4, x));
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
          const plotW = Math.max(10, r.width - 32 - 14);
          const touchGesture = e.pointerType === "touch";
          if (this.wfDragging.mode === "ystretch") {
            // Dragging UP stretches rows (fewer visible passes = taller rows); dragging DOWN compresses more passes
            if (!touchGesture || (Math.abs(dy) >= 12 && Math.abs(dy) >= Math.abs(dx) * 1.15)) {
              const factor = Math.exp(dy / 140);
              this.spectrumAcc.setVisibleRows(this.wfDragging.startVisibleRows * factor);
              this.updateScanFindings();
              this.dirtyWaterfall = true;
            }
          } else if (this.wfDragging.mode === "xstretch") {
            if (!touchGesture || (Math.abs(dx) >= 12 && Math.abs(dx) >= Math.abs(dy) * 1.15)) {
              const factor = Math.exp(-dx / 150);
              this.applyFreqStretch(this.wfDragging.startMHz0, this.wfDragging.startMHz1, this.wfDragging.anchorFrac, factor);
            }
          } else if (this.wfDragging.mode === "scrollbar") {
            scrubScrollbar(wf, e.clientY);
          } else if (this.wfDragging.mode === "zoom") {
            const clampedX = Math.max(32, Math.min(r.width - 14, x));
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
        } else if (x < 36 || (target.matches("[data-waterfall-canvas]") && x >= r.width - 24)) {
          target.style.cursor = "ns-resize";
        } else if (y >= r.height - 26 && x >= 32) {
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
      if (typeof window !== "undefined" && window.innerWidth <= 680) return;
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
  }

  private renderFrame(): void {
    const isRH = this.isRotorHazardMode();
    const rhSnap = isRH ? this.activeRhSnapshot() : null;
    const streamingNow = isRH
      ? Boolean(this.rhLiveOn && rhSnap?.connected)
      : Boolean(
          this.liveOn &&
            !this.scanLive &&
            !this.status?.emergencyMode &&
            this.status?.rf.enabled !== false
        );

    if (
      streamingNow &&
      this.signalEndN === null &&
      !this.signalDrag &&
      this.signalCardVisible &&
      this.signalRing.points.length > 0
    ) {
      this.dirtySignal = true;
    }
    if (this.dirtySignal) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-signal-canvas]");
      if (c) {
        this.updateAutoSignalAxes(c.clientWidth || 700);
        const effectiveEndN = this.signalEndN ?? (this.signalDrag ? this.signalDrag.startEndN : null);
        const effectiveRefN =
          this.signalEndN !== null ? this.signalRefN : this.signalDrag ? this.signalDrag.startEndN : null;
        if (isRH) {
          const nCount = rhSnap?.nodeCount === 4 ? 4 : 8;
          const rhFreqs = Array.from({ length: 8 }, (_, i) =>
            i < nCount ? (rhSnap?.nodeFreqsMhz[i] ?? 0) : 0
          );
          const nodeThresholds: Array<{ label: string; enter: number; exit?: number }> = [];
          for (let i = 0; i < nCount; i++) {
            if (!this.signalEnabledCh[i]) continue;
            const f = rhSnap?.nodeFreqsMhz[i] ?? 0;
            if (f <= 0) continue;
            nodeThresholds.push({
              label: `N${i + 1}`,
              enter: rhSnap?.nodeEnterLevels[i] ?? 90,
              exit: rhSnap?.nodeExitLevels[i] ?? 70,
            });
          }
          const enabledMask = this.signalEnabledCh.map((on, i) => on && i < nCount && rhFreqs[i] > 0);
          drawSignalOverTimeCanvas(c, this.signalRing, {
            windowSec: this.signalWindowSec,
            sweepHz: this.activeSweepHz(),
            endN: effectiveEndN,
            refN: effectiveRefN,
            yMinDbm: this.signalYMin,
            yMaxDbm: this.signalYMax,
            autoX: this.signalAutoX,
            autoY: this.signalAutoY,
            yZoomBox: this.signalYZoomBox,
            freqs: rhFreqs,
            enabledChannels: enabledMask,
            showFloor: this.signalShowFloor,
            showHitLine: false,
            showThresholds: this.signalShowThresholds,
            pilots: [],
            nodeThresholds,
            unitLabel: "RSSI",
            hover: this.signalHover,
          });
        } else {
          drawSignalOverTimeCanvas(c, this.signalRing, {
            windowSec: this.signalWindowSec,
            sweepHz: this.status?.sweepHz ?? 50,
            endN: effectiveEndN,
            refN: effectiveRefN,
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
        }
        this.dirtySignal = false;
      }
    }

    const now = performance.now();
    if (this.dirtyNoiseTable && now - this.lastNoiseTableRenderAt >= 250) {
      this.renderNoiseTable();
      this.dirtyNoiseTable = false;
      this.lastNoiseTableRenderAt = now;
    }

    if (this.dirtySpectrum && this.hasSpectrumScanSupport()) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-spectrum-canvas]");
      if (c) {
        const sb = this.scanYBounds();
        const prevColorMin = this.spectrumAcc.colorMinDbm;
        const prevColorMax = this.spectrumAcc.colorMaxDbm;
        this.updateAutoScanY();
        if (this.spectrumAcc.colorMinDbm !== prevColorMin || this.spectrumAcc.colorMaxDbm !== prevColorMax) {
          this.dirtyWaterfall = true;
          const wfMinEl = this.el.querySelector<HTMLElement>("[data-wf-color-min]");
          const wfMaxEl = this.el.querySelector<HTMLElement>("[data-wf-color-max]");
          if (wfMinEl) wfMinEl.textContent = `${this.spectrumAcc.colorMinDbm} ${sb.unit}`;
          if (wfMaxEl) wfMaxEl.textContent = `${this.spectrumAcc.colorMaxDbm} ${sb.unit}`;
        }
        drawSpectrumCanvas(c, this.spectrumAcc, {
          showMaxHold: this.scanShowMaxHold,
          showAverage: this.scanShowAvg,
          showWifiOverlay: this.scanShowWifi,
          viewStartMHz: this.scanZoomStartMHz,
          viewStopMHz: this.scanZoomStopMHz,
          fallbackStartMHz: this.scanStartMHz,
          fallbackStopMHz: Math.min(sb.maxFreqMHz, this.scanStopMHz),
          yMinDbm: this.scanYMin,
          yMaxDbm: this.scanYMax,
          autoY: this.scanAutoY,
          unitLabel: sb.unit,
          zoomBox: this.scanZoomBox,
          hover: this.scanHover,
        });
        this.dirtySpectrum = false;
      }
    }

    if (this.dirtyWaterfall && this.hasSpectrumScanSupport()) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-waterfall-canvas]");
      if (c) {
        const sb = this.scanYBounds();
        drawWaterfallCanvas(
          c,
          this.spectrumAcc,
          this.scanShowWifi,
          this.waterfallHover,
          this.scanZoomStartMHz,
          this.scanZoomStopMHz,
          this.scanZoomBox,
          this.scanStartMHz,
          Math.min(sb.maxFreqMHz, this.scanStopMHz),
          sb.unit
        );
        this.dirtyWaterfall = false;
      }
    }

    if (this.dirtyHealth) {
      const grid = this.el.querySelector<HTMLElement>("[data-health-grid]");
      if (grid) {
        if (isRH) {
          drawRHHealthSparklines(grid, this.rhHealthHistory);
        } else {
          drawHealthSparklines(grid, this.healthHistory, this.hasServer);
        }
        this.dirtyHealth = false;
      }
    }
  }

  /**
   * Real-world engine view of one timer (by board fingerprint) from the in-browser WASM engine,
   * or null when it isn't available (simulator active, or no ApiClient).
   */
  private async engineTimerInfo(fp: string): Promise<DebugTimerInfo | null> {
    const state = await this.api?.getRealEngineState();
    if (!state) return null;
    const want = fp.toUpperCase();
    const dt = (state.timers ?? []).find((t) => (t.fingerprint || "").toUpperCase() === want);
    if (!dt) return { found: false, online: false, framesRx: 0, simulatorActive: false };
    const seenMs = Date.parse(dt.lastSeenAt);
    // `gates` is empty (older servers: null) until the timer is placed on the Track page.
    const gate = (state.gates ?? []).find((g) => g.assignedTimerId === dt.timerId);
    return {
      found: true,
      timerId: dt.timerId,
      label: dt.timerLabel,
      online: dt.online,
      msSinceSeen: Number.isFinite(seenMs) && seenMs > 0 ? Math.max(0, Date.now() - seenMs) : undefined,
      framesRx: gate?.framesRxCount ?? 0,
      simulatorActive: false,
    };
  }

  private async fetchPilotThresholds(): Promise<void> {
    try {
      // Real-world engine state from the in-browser WASM engine (null while the simulator runs).
      const state = await this.api?.getRealEngineState();
      if (!state) return;
      const data = {
        pilots: state.pilots as PilotThresholdInfo[],
        timers: state.timers,
        gates: (state.gates ?? []).map((g) => ({ ...g, timerLabel: g.timerLabel ?? "", online: Boolean(g.online) })),
        simulatorActive: state.simulatorRunning,
      };
      this.serverSimActive = Boolean(data.simulatorActive);
      if (Array.isArray(data.gates)) {
        this.serverGates = data.gates;
      }
      const timers = data.timers;
      if (Array.isArray(timers)) {
        this.serverTimers = timers;
        if (!this.serverSimActive) {
          for (const dt of timers) {
            const fp = (dt.fingerprint || "").toUpperCase();
            if (fp && fp !== "00000001" && !fp.startsWith("SIM000")) {
              recordKnownHardwareTimer({
                fp,
                role: dt.isHub ? "hub" : "spoke",
                label: dt.timerLabel,
                fw: dt.firmwareVersion,
                slot: dt.timerId >= 1 && dt.timerId <= 7 ? dt.timerId : undefined,
              });
            }
          }
        }
        this.renderNetworkView();
      }
      if (Array.isArray(data.pilots)) {
        this.pilots = data.pilots;
        this.hasServer = true;
        this.dirtySignal = true;
        this.dirtyNoiseTable = true;
        this.dirtyHealth = true;
      }
    } catch {
      // Engine not ready yet: skip silently (§5.1)
    }
  }

  private async pollServerHealth(s: TimerStatus): Promise<void> {
    let framesRx: number | null = null;
    const info = await this.engineTimerInfo(s.fp);
    if (info) {
      this.hasServer = true;
      if (info.found) framesRx = info.framesRx;
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
        case "serial-wrap":
          this.serialWrap = t.checked;
          this.renderSerialConsole();
          break;
        case "log-wrap":
          this.logWrap = t.checked;
          this.renderLog();
          break;
      }
      this.saveDebugPrefs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|aborted|cancelled|cancel/i.test(msg)) {
        this.error = msg;
      }
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
        case "connect-add": {
          const isBle = this.hwMode() === "slaprf_ble";
          await usbPool.connectOrSwapDebug(isBle ? false : this.showAllPorts);
          break;
        }
        case "revert-usb-main":
          await usbPool.revertDebugToMain();
          break;
        case "select-usb-slot": {
          const slot = Number(t.dataset.usbSlot);
          if (Number.isFinite(slot)) {
            usbPool.setDebugSlot(slot);
          }
          break;
        }
        case "disconnect-usb-slot": {
          const slot = Number(t.dataset.usbSlot);
          const targetConsole = usbPool.slots[slot];
          const isHub = targetConsole?.lastStatus
            ? targetConsole.lastStatus.role === 1
            : targetConsole?.lastConfig?.role === "hub";
          if (targetConsole && !isHub) {
            if (slot === 1) {
              await usbPool.revertDebugToMain();
            } else {
              await targetConsole.disconnectCleanly();
              if (usbPool.slots[1]?.connected) {
                usbPool.setDebugSlot(1);
              }
            }
          }
          break;
        }
        case "disconnect": {
          const isHub = this.console.lastStatus
            ? this.console.lastStatus.role === 1
            : this.console.lastConfig?.role === "hub";
          if (!isHub) {
            if (this.console.slotIndex === 1) {
              await usbPool.revertDebugToMain();
            } else {
              await this.console.disconnectCleanly();
              if (usbPool.slots[1]?.connected) {
                usbPool.setDebugSlot(1);
              }
            }
          }
          break;
        }
        case "select-rh-timer": {
          const tid = Number(t.dataset.timerId);
          if (Number.isFinite(tid) && tid !== this.selectedRhTimerId) {
            const prevTid = this.selectedRhTimerId;
            if (this.scanLive && this.isRotorHazardUSBMode() && prevTid && prevTid > 0) {
              await this.runRhUsbScanCommand("stop", this.scanStartMHz, this.scanStopMHz, this.scanStepMHz, prevTid).catch(() => undefined);
            }
            this.selectedRhTimerId = tid;
            this.resetSignalBuffersForTargetChange();
            if (this.rhLiveOn) {
              if (prevTid && prevTid > 0) {
                await this.api?.setRHDebugStream(prevTid, false).catch(() => undefined);
              }
              await this.syncRhDebugStream(true, tid);
            }
            this.renderAll();
            this.ingestRotorHazardSample();
          }
          break;
        }
        case "connect-rh-timer": {
          const tid = Number(t.dataset.timerId);
          if (this.store && this.api && this.store.simulatorRunning && Number.isFinite(tid)) {
            if (this.isRotorHazardUSBMode()) {
              await this.api.simRotorHazardAction({
                action: "connect",
                timerId: tid,
              });
            } else {
              await this.api.simRotorHazardAction({
                action: "connect",
                timerId: tid,
                adminUser: "admin",
                adminPass: "rotorhazard",
              });
            }
            this.selectedRhTimerId = tid;
            this.rhLiveOn = true;
            this.resetSignalBuffersForTargetChange();
            await this.syncRhDebugStream(true, tid);
          } else {
            window.location.hash = "#/network";
          }
          break;
        }
        case "go-network-timers":
          window.location.hash = "#/network";
          break;
        case "live":
          if (this.isRotorHazardMode()) {
            if (this.isRotorHazardUSBMode() && this.scanLive) {
              this.scanLive = false;
              await this.runRhUsbScanCommand("stop").catch(() => undefined);
              this.rhLiveOn = true;
              this.signalEndN = null;
              await this.syncRhDebugStream(true);
              this.renderScan();
            } else {
              this.rhLiveOn = !this.rhLiveOn;
              if (this.rhLiveOn) {
                this.signalEndN = null;
              } else if (this.signalEndN === null && this.signalRing.points.length > 0) {
                this.pauseSignalAt(this.signalRing.latestN());
              }
              await this.syncRhDebugStream(this.rhLiveOn);
            }
            this.renderLiveHead();
            this.renderSignalControls();
            this.dirtySignal = true;
            this.dirtyNoiseTable = true;
            break;
          }
          if (this.scanLive || this.status?.scanLive) {
            this.scanToggleAt = Date.now();
            this.scanLive = false;
            if (this.status) this.status.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
            this.liveOn = true;
            this.signalEndN = null;
            await this.syncRfState(true);
            await this.console.send(`LIVE ${this.liveMode}`);
            this.renderScan();
            this.renderChannels();
          } else {
            this.liveOn = !this.liveOn;
            if (this.liveOn) {
              this.signalEndN = null;
              await this.syncRfState(true);
              await this.console.send(`LIVE ${this.liveMode}`);
            } else {
              if (this.signalEndN === null && this.signalRing.points.length > 0) {
                this.pauseSignalAt(this.signalRing.latestN());
              }
              await this.console.send("LIVE 0");
              await this.syncRfState();
            }
          }
          this.renderLiveHead();
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "channels-apply": {
          const freqs = [...this.el.querySelectorAll<HTMLInputElement>("[data-chan]")].map((i) => Math.round(Number(i.value)));
          if (freqs.length !== 8 || freqs.some((f) => !(f >= 5180 && f <= 5945))) {
            throw new Error("Each channel must be between 5180 and 5945 MHz.");
          }
          await this.console.request(`CHANNELS ${freqs.join(",")}`, "ok", 2000);
          this.channelsDirty = false;
          await this.refreshStatus();
          this.renderLive();
          this.renderChannels();
          this.renderSignalControls();
          this.renderNoiseTable();
          break;
        }
        case "channels-raceband":
          this.el.querySelectorAll<HTMLInputElement>("[data-chan]").forEach((i, n) => (i.value = String(RACEBAND[n])));
          this.syncChannelInputsState();
          break;
        case "channels-reset":
          if (this.status?.freqsTemporary) {
            await this.console.request("CHANNELS RESET", "ok", 2000);
            this.channelsDirty = false;
            await this.refreshStatus();
            this.renderLive();
            this.renderChannels();
            this.renderSignalControls();
            this.renderNoiseTable();
          } else {
            const saved = this.status?.freqs ?? RACEBAND;
            this.el.querySelectorAll<HTMLInputElement>("[data-chan]").forEach((i, n) => (i.value = String(saved[n] ?? RACEBAND[n])));
            this.syncChannelInputsState();
          }
          break;
        case "toggle-axis-menu": {
          const menu = (t.dataset.menu as "signal-x" | "signal-y" | "scan-band" | "scan-x" | "scan-y" | "wf-x" | "wf-y" | undefined) ?? null;
          this.openAxisMenu = this.openAxisMenu === menu ? null : menu;
          if (menu === "signal-x" || menu === "signal-y") {
            this.renderSignalControls();
          } else {
            this.renderScan();
          }
          break;
        }
        case "signal-auto-x":
          this.openAxisMenu = null;
          if (t.dataset.force === "1") {
            this.signalAutoX = true;
          } else {
            this.signalAutoX = !this.signalAutoX;
          }
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "signal-window": {
          this.openAxisMenu = null;
          const w = Number(t.dataset.win);
          if (w > 0 && w <= 120) {
            this.signalAutoX = false;
            const sweepHz = this.activeSweepHz();
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
          if (this.isRotorHazardMode()) {
            const rhSnap = this.activeRhSnapshot();
            if (this.isRotorHazardUSBMode() && this.scanLive && rhSnap?.connected) {
              this.scanLive = false;
              await this.runRhUsbScanCommand("stop").catch(() => undefined);
              this.rhLiveOn = true;
              this.signalEndN = null;
              await this.syncRhDebugStream(true);
              this.renderScan();
              this.renderLiveHead();
            } else if (!this.rhLiveOn && rhSnap?.connected) {
              this.rhLiveOn = true;
              this.signalEndN = null;
              await this.syncRhDebugStream(true);
              this.renderLiveHead();
            } else if (this.signalEndN === null) {
              this.rhLiveOn = false;
              if (this.signalRing.points.length > 0) {
                this.pauseSignalAt(this.signalRing.latestN());
              }
              await this.syncRhDebugStream(false);
              this.renderLiveHead();
            } else {
              this.signalEndN = null;
            }
            this.renderSignalControls();
            this.dirtySignal = true;
            this.dirtyNoiseTable = true;
            break;
          }
          if (this.scanLive || this.status?.scanLive) {
            this.scanToggleAt = Date.now();
            this.scanLive = false;
            if (this.status) this.status.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
            this.liveOn = true;
            this.signalEndN = null;
            await this.syncRfState(true);
            await this.console.send(`LIVE ${this.liveMode}`);
            this.renderScan();
            this.renderLiveHead();
            this.renderChannels();
          } else if (!this.liveOn && this.console.connected) {
            this.liveOn = true;
            this.signalEndN = null;
            await this.syncRfState(true);
            await this.console.send(`LIVE ${this.liveMode}`);
            this.renderLiveHead();
          } else if (this.signalEndN === null) {
            this.liveOn = false;
            this.pauseSignalAt(this.signalRing.latestN());
            if (this.console.connected) {
              await this.console.send("LIVE 0");
              await this.syncRfState();
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
          this.openAxisMenu = null;
          if (t.dataset.force === "1") {
            this.signalAutoY = true;
            this.signalSmoothYMin = null;
            this.signalSmoothYMax = null;
          } else {
            this.signalAutoY = !this.signalAutoY;
            if (!this.signalAutoY) {
              const yb = this.signalYBounds();
              this.signalYMin = yb.min;
              this.signalYMax = yb.max;
            } else {
              this.signalSmoothYMin = null;
              this.signalSmoothYMax = null;
            }
          }
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-reset-y":
          this.openAxisMenu = null;
          this.signalAutoY = true;
          this.signalSmoothYMin = null;
          this.signalSmoothYMax = null;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-full-y": {
          this.openAxisMenu = null;
          const yb = this.signalYBounds();
          this.signalAutoY = false;
          this.signalYMin = yb.min;
          this.signalYMax = yb.max;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        }
        case "signal-reset-x":
          this.openAxisMenu = null;
          this.signalAutoX = true;
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "signal-zoom-floor": {
          this.openAxisMenu = null;
          const yb = this.signalYBounds();
          this.signalAutoY = false;
          this.signalYMin = yb.floorPresetMin;
          this.signalYMax = yb.floorPresetMax;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        }
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
            this.syncChannelMaskToFirmware();
            this.updateLive();
            this.renderStatus();
            this.renderSignalControls();
            this.renderNoiseTable();
            this.dirtySignal = true;
          }
          break;
        }
        case "signal-ch-all": {
          const allOn = this.signalEnabledCh.every(Boolean);
          this.signalEnabledCh = this.signalEnabledCh.map(() => !allOn);
          this.syncChannelMaskToFirmware();
          this.updateLive();
          this.renderStatus();
          this.renderSignalControls();
          this.renderNoiseTable();
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
            buildFileStamp(
              this.isRotorHazardMode()
                ? ({ label: this.activeRhSnapshot()?.label || "R1" } as TimerStatus)
                : this.status,
              "signal",
              "csv"
            ),
            exportSignalCsv(this.signalRing, this.activeSweepHz())
          );
          break;
        case "export-signal-png": {
          const c = this.el.querySelector<HTMLCanvasElement>("[data-signal-canvas]");
          if (c) {
            downloadCanvasPng(
              c,
              buildFileStamp(
                this.isRotorHazardMode()
                  ? ({ label: this.activeRhSnapshot()?.label || "R1" } as TimerStatus)
                  : this.status,
                "signal",
                "png"
              )
            );
          }
          break;
        }
        case "scan": {
          const sb = this.scanYBounds();
          const start = this.scanStartMHz;
          const stop = Math.min(sb.maxFreqMHz, this.scanStopMHz);
          const step = this.scanStepMHz;
          this.scanning = true;
          this.renderScan();
          if (this.isRotorHazardUSBMode()) {
            await this.runRhUsbScanCommand("once", start, stop, step).catch((err: Error) => {
              this.scanning = false;
              this.renderScan();
              throw err;
            });
            break;
          }
          await this.syncRfState(true);
          await this.console.request(`SCAN ${start} ${stop} ${step}`, "scan", 5000).catch((err: Error) => {
            this.scanning = false;
            this.renderScan();
            void this.syncRfState();
            throw err;
          });
          break;
        }
        case "scan-live": {
          this.scanToggleAt = Date.now();
          if (this.isRotorHazardUSBMode()) {
            const sb = this.scanYBounds();
            const start = this.scanStartMHz;
            const stop = Math.min(sb.maxFreqMHz, this.scanStopMHz);
            const step = this.scanStepMHz;
            if (this.scanLive) {
              this.scanLive = false;
              await this.runRhUsbScanCommand("stop", start, stop, step).catch(() => undefined);
            } else {
              this.rhLiveOn = false;
              this.spectrumAcc.clearHoldAndAvg();
              await this.runRhUsbScanCommand("live", start, stop, step);
              this.scanLive = true;
            }
            this.renderStatus();
            this.renderScan();
            this.renderLiveHead();
            this.renderSignalControls();
            break;
          }
          if (this.scanLive) {
            this.scanLive = false;
            if (this.status) this.status.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
            if (this.liveOn) {
              this.liveOn = false;
              await this.console.send("LIVE 0").catch(() => undefined);
            }
            await this.syncRfState();
          } else {
            if (this.liveOn) {
              this.liveOn = false;
              await this.console.send("LIVE 0").catch(() => undefined);
            }
            await this.syncRfState(true);
            const start = this.scanStartMHz;
            const stop = this.scanStopMHz;
            const step = this.scanStepMHz;
            this.spectrumAcc.clearHoldAndAvg();
            await this.console.request(`SCAN LIVE ${start} ${stop} ${step}`, "ok", 2000);
            this.scanLive = true;
            if (this.status) this.status.scanLive = true;
          }
          this.renderStatus();
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
          this.openAxisMenu = null;
          this.spectrumAcc.setVisibleRows(80);
          this.renderScan();
          break;
        case "wf-rows": {
          this.openAxisMenu = null;
          const rows = Number(t.dataset.rows) || 80;
          this.spectrumAcc.setVisibleRows(rows);
          this.renderScan();
          break;
        }
        case "scan-reset-zoom":
          this.openAxisMenu = null;
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          this.renderScan();
          break;
        case "scan-zoom-range": {
          this.openAxisMenu = null;
          const f0 = Number(t.dataset.start);
          const f1 = Number(t.dataset.stop);
          if (f0 > 0 && f1 > f0) {
            this.scanZoomStartMHz = f0;
            this.scanZoomStopMHz = f1;
          }
          this.renderScan();
          break;
        }
        case "scan-reset-y":
        case "scan-full-y": {
          const sb = this.scanYBounds();
          this.openAxisMenu = null;
          this.scanAutoY = false;
          this.scanYMin = sb.min;
          this.scanYMax = sb.max;
          this.syncScanColorRange();
          this.renderScan();
          break;
        }
        case "scan-auto-y":
          this.openAxisMenu = null;
          if (t.dataset.force === "1") {
            this.scanAutoY = true;
          } else {
            this.scanAutoY = !this.scanAutoY;
            if (!this.scanAutoY) {
              const sb = this.scanYBounds();
              this.scanYMin = sb.min;
              this.scanYMax = sb.max;
              this.syncScanColorRange();
            }
          }
          this.renderScan();
          break;
        case "scan-preset": {
          this.openAxisMenu = null;
          const sb = this.scanYBounds();
          const start = Number(t.dataset.start) || 5180;
          const stop = Math.min(sb.maxFreqMHz, Number(t.dataset.stop) || sb.maxFreqMHz);
          const step = Number(t.dataset.step) || 5;
          this.scanStartMHz = start;
          this.scanStopMHz = stop;
          this.scanStepMHz = step;
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          if (this.scanLive) {
            this.scanToggleAt = Date.now();
            this.spectrumAcc.clearHoldAndAvg();
            if (this.isRotorHazardUSBMode()) {
              await this.runRhUsbScanCommand("live", start, stop, step);
            } else if (this.console.connected) {
              await this.console.request(`SCAN LIVE ${start} ${stop} ${step}`, "ok", 2000);
            }
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
        case "export-spectrum-csv":
          downloadTextFile(
            buildFileStamp(
              this.isRotorHazardMode()
                ? ({ label: this.activeRhSnapshot()?.label || "R1" } as TimerStatus)
                : this.status,
              "spectrum",
              "csv"
            ),
            exportSpectrumCsv(this.spectrumAcc, this.isRotorHazardUSBMode())
          );
          break;
        case "export-scan-csv":
          downloadTextFile(
            buildFileStamp(
              this.isRotorHazardMode()
                ? ({ label: this.activeRhSnapshot()?.label || "R1" } as TimerStatus)
                : this.status,
              "waterfall",
              "csv"
            ),
            exportScanHistoryCsv(this.spectrumAcc)
          );
          break;
        case "export-spectrum-png": {
          const c = this.el.querySelector<HTMLCanvasElement>("[data-spectrum-canvas]");
          if (c) {
            downloadCanvasPng(
              c,
              buildFileStamp(
                this.isRotorHazardMode()
                  ? ({ label: this.activeRhSnapshot()?.label || "R1" } as TimerStatus)
                  : this.status,
                "spectrum",
                "png"
              )
            );
          }
          break;
        }
        case "export-waterfall-png": {
          const c = this.el.querySelector<HTMLCanvasElement>("[data-waterfall-canvas]");
          if (c) {
            downloadCanvasPng(
              c,
              buildFileStamp(
                this.isRotorHazardMode()
                  ? ({ label: this.activeRhSnapshot()?.label || "R1" } as TimerStatus)
                  : this.status,
                "waterfall",
                "png"
              )
            );
          }
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
          await this.sendSerialCommand("SLAPRF?");
          break;
        case "refresh-status":
          if (this.isRotorHazardMode()) {
            await this.tickNonSlapRFTelemetry();
            this.renderStatus();
          } else {
            await this.refreshStatus();
          }
          break;
        case "select-net-spoke": {
          const slotNum = Number(t.dataset.spokeSlot);
          if (slotNum >= 2 && slotNum <= 7) {
            this.selectedNetworkSpokeSlot = slotNum;
            this.renderNetworkView();
          }
          break;
        }
        case "selftest":
          await this.runBusy("Self-test", () =>
            this.isRotorHazardMode() ? this.runRhSelfTest() : this.runSelfTest()
          );
          break;
        case "copy-report":
          await this.copy(this.reportText(), t);
          break;
        case "serial-help":
          await this.sendSerialCommand("HELP");
          break;
        case "bootlog":
          await this.sendSerialCommand("BOOTLOG?");
          break;
        case "lastlog":
          await this.sendSerialCommand("LASTLOG?");
          break;
        case "copy-bootlog":
          if (this.bootLog) await this.copy(this.bootLogHeader(this.bootLog) + "\n" + this.bootLog.text, t);
          break;
        case "copy-serial":
          await this.copy(this.serialLines.join("\n"), t);
          break;
        case "serial-send": {
          const inp = this.el.querySelector<HTMLInputElement>("[data-serial-input]");
          if (inp) await this.sendSerialCommand(inp.value);
          break;
        }
        case "serial-cmd": {
          const cmd = t.dataset.cmd ?? "";
          if (cmd) await this.sendSerialCommand(cmd);
          break;
        }
        case "serial-clear":
          this.serialLines = [];
          this.renderSerialConsole();
          this.scrollSerialToBottom(true);
          break;
        case "serial-wrap":
          this.serialWrap = !this.serialWrap;
          this.renderSerialConsole();
          break;
        case "log-wrap":
          this.logWrap = !this.logWrap;
          this.renderLog();
          break;
        case "restore-live-channels":
          this.signalEnabledCh = [true, true, true, true, true, true, true, true];
          this.syncChannelMaskToFirmware();
          this.updateLive();
          this.renderStatus();
          this.renderSignalControls();
          this.renderNoiseTable();
          this.dirtySignal = true;
          break;
        case "restore-signal-defaults": {
          const yb = this.signalYBounds();
          this.openAxisMenu = null;
          this.signalEndN = null;
          this.signalAutoX = true;
          this.signalWindowSec = 15;
          this.signalAutoY = true;
          this.signalYMin = yb.min;
          this.signalYMax = yb.max;
          this.signalSmoothYMin = null;
          this.signalSmoothYMax = null;
          this.signalShowFloor = true;
          this.signalShowHitLine = true;
          this.signalShowThresholds = true;
          this.signalEnabledCh = [true, true, true, true, true, true, true, true];
          this.syncChannelMaskToFirmware();
          this.updateLive();
          this.renderStatus();
          this.renderSignalControls();
          this.renderNoiseTable();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        }
        case "restore-spectrum-defaults": {
          const sb = this.scanYBounds();
          this.openAxisMenu = null;
          this.scanShowMaxHold = true;
          this.scanShowAvg = true;
          this.scanShowWifi = true;
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          this.scanAutoY = this.isRotorHazardUSBMode();
          this.scanYMin = sb.min;
          this.scanYMax = this.isRotorHazardUSBMode() ? 120 : sb.max;
          this.syncScanColorRange();
          this.scanStartMHz = 5180;
          this.scanStopMHz = sb.maxFreqMHz;
          this.scanStepMHz = 5;
          if (this.scanLive) {
            this.scanToggleAt = Date.now();
            this.spectrumAcc.clearHoldAndAvg();
            if (this.isRotorHazardUSBMode()) {
              await this.runRhUsbScanCommand("live", 5180, sb.maxFreqMHz, 5).catch(() => undefined);
            } else if (this.console.connected) {
              await this.console.request("SCAN LIVE 5180 5945 5", "ok", 2000).catch(() => undefined);
            }
          }
          this.renderScan();
          break;
        }
        case "restore-waterfall-defaults":
          this.openAxisMenu = null;
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          this.spectrumAcc.setVisibleRows(80);
          this.spectrumAcc.setScrollRow(0);
          this.renderScan();
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|cancel/i.test(msg)) this.error = msg;
    }
    this.renderConnection();
    this.saveDebugPrefs();
  }

  private loadDebugPrefs(): void {
    try {
      const raw = window.localStorage.getItem("slaprf.ui.debug_prefs.v1");
      if (!raw) return;
      const p = JSON.parse(raw) as Record<string, unknown>;
      if (typeof p.showAllPorts === "boolean") this.showAllPorts = p.showAllPorts;
      if (Array.isArray(p.signalEnabledCh) && p.signalEnabledCh.length === 8) {
        this.signalEnabledCh = p.signalEnabledCh.map(Boolean);
      }
      if (typeof p.signalWindowSec === "number" && p.signalWindowSec >= 0.4 && p.signalWindowSec <= 120) {
        this.signalWindowSec = p.signalWindowSec;
      }
      if (typeof p.signalAutoX === "boolean") this.signalAutoX = p.signalAutoX;
      if (typeof p.signalAutoY === "boolean") this.signalAutoY = p.signalAutoY;
      if (
        !this.signalAutoY &&
        typeof p.signalYMin === "number" &&
        typeof p.signalYMax === "number" &&
        p.signalYMax > p.signalYMin
      ) {
        this.signalYMin = Math.max(DBM_MIN, Math.min(DBM_MAX, p.signalYMin));
        this.signalYMax = Math.max(this.signalYMin + 4, Math.min(DBM_MAX, p.signalYMax));
        this.signalSmoothYMin = this.signalYMin;
        this.signalSmoothYMax = this.signalYMax;
      }
      if (typeof p.signalShowFloor === "boolean") this.signalShowFloor = p.signalShowFloor;
      if (typeof p.signalShowHitLine === "boolean") this.signalShowHitLine = p.signalShowHitLine;
      if (typeof p.signalShowThresholds === "boolean") this.signalShowThresholds = p.signalShowThresholds;
      if (typeof p.scanShowMaxHold === "boolean") this.scanShowMaxHold = p.scanShowMaxHold;
      if (typeof p.scanShowAvg === "boolean") this.scanShowAvg = p.scanShowAvg;
      if (typeof p.scanShowWifi === "boolean") this.scanShowWifi = p.scanShowWifi;
      if (typeof p.scanStartMHz === "number" && p.scanStartMHz >= 5180) this.scanStartMHz = p.scanStartMHz;
      if (typeof p.scanStopMHz === "number" && p.scanStopMHz <= 5945) {
        this.scanStopMHz = p.scanStopMHz === 5917 || p.scanStopMHz === 5925 ? 5945 : p.scanStopMHz;
      }
      if (typeof p.scanStepMHz === "number" && p.scanStepMHz >= 1) this.scanStepMHz = p.scanStepMHz;
      if (
        typeof p.scanZoomStartMHz === "number" &&
        typeof p.scanZoomStopMHz === "number" &&
        p.scanZoomStopMHz > p.scanZoomStartMHz
      ) {
        const zSpan = p.scanZoomStopMHz - p.scanZoomStartMHz;
        const fullSpan = this.scanStopMHz - this.scanStartMHz;
        if (zSpan >= 725 || Math.abs(zSpan - fullSpan) <= 10) {
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
        } else {
          this.scanZoomStartMHz = Math.max(this.scanStartMHz, p.scanZoomStartMHz);
          this.scanZoomStopMHz = Math.min(this.scanStopMHz, p.scanZoomStopMHz);
        }
      } else if (p.scanZoomStartMHz === null || p.scanZoomStopMHz === null) {
        this.scanZoomStartMHz = null;
        this.scanZoomStopMHz = null;
      }
      if (typeof p.scanAutoY === "boolean") this.scanAutoY = p.scanAutoY;
      if (
        !this.scanAutoY &&
        typeof p.scanYMin === "number" &&
        typeof p.scanYMax === "number" &&
        p.scanYMax > p.scanYMin
      ) {
        this.scanYMin = Math.max(DBM_MIN, Math.min(DBM_MAX, p.scanYMin));
        this.scanYMax = Math.max(this.scanYMin + 4, Math.min(DBM_MAX, p.scanYMax));
        if (this.scanYMin === DBM_MIN && this.scanYMax === DBM_MAX) {
          this.spectrumAcc.setColorRange(-100, -40);
        } else {
          this.spectrumAcc.setColorRange(this.scanYMin, Math.min(-25, this.scanYMax));
        }
      }
      if (typeof p.wfVisibleRows === "number" && p.wfVisibleRows >= 10 && p.wfVisibleRows <= 300) {
        this.spectrumAcc.setVisibleRows(p.wfVisibleRows);
      }
      if (typeof p.selectedNetworkSpokeSlot === "number" && p.selectedNetworkSpokeSlot >= 2 && p.selectedNetworkSpokeSlot <= 7) {
        this.selectedNetworkSpokeSlot = p.selectedNetworkSpokeSlot;
      }
      if (typeof p.serialWrap === "boolean") this.serialWrap = p.serialWrap;
      if (typeof p.logWrap === "boolean") this.logWrap = p.logWrap;
      if (Array.isArray(p.serialHistory)) {
        this.serialHistory = p.serialHistory.filter((x): x is string => typeof x === "string").slice(-50);
      }
    } catch {
      // ignore storage errors
    }
  }

  private saveDebugPrefs(): void {
    try {
      const isSlap = this.isSlapRFMode();
      window.localStorage.setItem(
        "slaprf.ui.debug_prefs.v1",
        JSON.stringify({
          showAllPorts: this.showAllPorts,
          signalEnabledCh: this.signalEnabledCh,
          signalWindowSec: this.signalWindowSec,
          signalAutoX: this.signalAutoX,
          signalAutoY: this.signalAutoY,
          signalYMin: isSlap ? this.signalYMin : DBM_MIN,
          signalYMax: isSlap ? this.signalYMax : DBM_MAX,
          signalShowFloor: this.signalShowFloor,
          signalShowHitLine: this.signalShowHitLine,
          signalShowThresholds: this.signalShowThresholds,
          scanShowMaxHold: this.scanShowMaxHold,
          scanShowAvg: this.scanShowAvg,
          scanShowWifi: this.scanShowWifi,
          scanStartMHz: this.scanStartMHz,
          scanStopMHz: isSlap ? this.scanStopMHz : 5945,
          scanStepMHz: this.scanStepMHz,
          scanZoomStartMHz: this.scanZoomStartMHz,
          scanZoomStopMHz: this.scanZoomStopMHz,
          scanAutoY: this.scanAutoY,
          scanYMin: isSlap ? this.scanYMin : DBM_MIN,
          scanYMax: isSlap ? this.scanYMax : DBM_MAX,
          wfVisibleRows: this.spectrumAcc.visibleRows,
          selectedNetworkSpokeSlot: this.selectedNetworkSpokeSlot,
          serialWrap: this.serialWrap,
          logWrap: this.logWrap,
          serialHistory: this.serialHistory.slice(-50),
        })
      );
    } catch {
      // ignore storage errors
    }
  }

  /** Start polling status on an opened port (streaming only begins when explicitly started by the user). */
  private async startSession(): Promise<void> {
    window.clearInterval(this.statusTimer);
    const s = this.status ?? (await this.console.ensureRunningApp());
    if (s) this.status = s;
    this.console.startStatusPolling();
    if (s?.emergencyMode) {
      this.liveOn = false;
      this.scanLive = false;
      this.resumeLiveAfterReconnect = false;
      this.resumeScanLiveAfterReconnect = false;
    } else {
      const resumeScan = this.resumeScanLiveAfterReconnect;
      const resumeLive = !resumeScan && this.resumeLiveAfterReconnect;
      this.resumeLiveAfterReconnect = false;
      this.resumeScanLiveAfterReconnect = false;
      this.liveOn = false;
      this.liveMode = this.signalCardVisible ? 2 : 1;
      await this.syncRfState();
      if (resumeScan && this.console.connected) {
        this.scanLive = true;
        if (this.status) this.status.scanLive = true;
        await this.console
          .request(`SCAN LIVE ${this.scanStartMHz} ${this.scanStopMHz} ${this.scanStepMHz}`, "ok", 2000)
          .catch(() => {
            this.scanLive = false;
          });
      } else if (resumeLive && this.console.connected) {
        this.liveOn = true;
        await this.console.send(`LIVE ${this.liveMode}`).catch(() => {
          this.liveOn = false;
        });
      }
    }
    if (this.logOn) await this.console.send("LOG 1");
    this.renderAll();
  }

  private async refreshStatus(): Promise<TimerStatus> {
    try {
      return await this.console.request<TimerStatus>("STATUS?", "status", 2000);
    } catch (err) {
      const recovered = await this.console.ensureRunningApp();
      if (recovered) return recovered;
      throw err;
    }
  }

  private async runBusy(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = name;
    this.console.setBusyLabel(name);
    this.progress = "";
    this.renderBusy();
    try {
      await fn();
    } finally {
      this.busy = null;
      this.console.setBusyLabel(null);
      this.progress = "";
      this.renderBusy();
    }
  }

  private setProgress(text: string): void {
    this.progress = text;
    this.renderSelfTest();
    this.renderSerialConsole();
  }

  private async copy(text: string, button: HTMLElement): Promise<void> {
    await navigator.clipboard.writeText(text);
    const label = button.querySelector("span");
    if (label) {
      const old = label.textContent;
      label.textContent = "Copied";
      window.setTimeout(() => (label.textContent = old), 1500);
    } else {
      const oldHtml = button.innerHTML;
      button.innerHTML = icons.check(17);
      window.setTimeout(() => (button.innerHTML = oldHtml), 1500);
    }
  }

  // ---------------------------------------------------------------- restarts

  /** Restart, reattach, re-enable the streams the user had on. Returns the first status. */
  private async restart(cmd: "REBOOT" = "REBOOT"): Promise<TimerStatus> {
    window.clearInterval(this.statusTimer);
    this.live = null;
    this.scanLive = false; // The firmware forgets it on restart
    this.renderScan();
    try {
      const s = await this.console.restartAndReconnect(15000, cmd);
      this.renderConnection();
      await this.startSession();
      return s;
    } catch (err) {
      await this.console.disconnect();
      throw err;
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
    await this.syncRfState(true);
    const add = (name: string, result: CheckResult, detail: string) => {
      this.checks.push({ name, result, detail });
      this.renderSelfTest();
    };

    try {
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
      if (s.fp.toUpperCase() === UNPROVISIONED_FP)
        add("Identity", "warn", `Firmware ${s.fw}, but not set up yet (default fingerprint). Use the Flasher page to give it an identity.`);
      else add("Identity", "pass", `${s.label || "(unnamed)"} | ${s.role === 1 ? "Hub" : "Spoke"} | ${s.fw} | ${s.fp}`);

      // 3. Receiver
      if (!s.rf.ok) add("5.8 GHz receiver", "fail", "the receiver's boot check failed; restart the timer and look at the boot log");
      else if (s.rf.floorDb < -100 || s.rf.floorDb > -80)
        add("5.8 GHz receiver", "warn", `noise floor ${s.rf.floorDb.toFixed(1)} dBm is outside the usual -100..-80 dBm (antenna, or strong interference nearby)`);
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
          const scan = await this.console.request<ScanResult>("SCAN 5180 5945 5", "scan", 4000);
          const ms = Math.round(performance.now() - t0);
          const expected = Math.floor((5945 - 5180) / 5) + 1;
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
        else add("Saved configuration", "pass", `${c.role} "${c.timerLabel}", ${c.frequenciesMHz.length} channels`);
      } catch (err) {
        add("Saved configuration", "fail", `couldn't read it (${err instanceof Error ? err.message : err})`);
      }

      // 8. Memory
      add(
        "Memory",
        s.heapMin > 20 * 1024 ? "pass" : "warn",
        `${(s.heapFree / 1024).toFixed(0)} KB free, lowest ${(s.heapMin / 1024).toFixed(0)} KB${s.heapMin > 20 * 1024 ? "" : " (low: it may run out)"}`
      );

      // 9. Last restart & emergency-mode guard
      if (s.emergencyMode) {
        add(
          "Last restart",
          "fail",
          `EMERGENCY MODE after ${s.crashStreak ?? 3} consecutive ${s.reset} resets: radio & sweeps halted so USB stays up for rescue/reflashing`
        );
        try {
          const last = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000);
          this.bootLog = last;
          this.reportExtra = `\n--- previous boot log (${last.reset}) ---\n${last.text}`;
          this.renderRestart();
        } catch {
          // report without it
        }
      } else if (BAD_RESETS.includes(s.reset)) {
        add("Last restart", "warn", `${s.reset}, boot #${s.boots} (previous boot crashed or lost power; boot log attached)`);
        try {
          const last = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000);
          this.bootLog = last;
          this.reportExtra = `\n--- previous boot log (${last.reset}) ---\n${last.text}`;
          this.renderRestart();
        } catch {
          // report without it
        }
      } else add("Last restart", "pass", `${s.reset}, boot #${s.boots}`);

      // 10. Course link (2.4 GHz ESP-NOW)
      if (s.role === 1) {
        add("Course link", "pass", `Hub beaconing on channel ${s.channel}`);
      } else {
        add("Course link", s.slot >= 2 ? "pass" : "warn", s.slot >= 2 ? `joined the Hub, slot ${s.slot}, channel ${s.channel}` : "not joined to a Hub yet (is the Hub on and in range?)");
      }

      // 11. Data reaching the in-browser timing engine
      this.setProgress("Checking that its data reaches the timing engine…");
      add(...(await this.checkNetworkPath(s)));
    } finally {
      await this.syncRfState(this.liveOn || this.scanLive || this.scanning);
    }
  }

  private async checkNetworkPath(s: TimerStatus): Promise<[string, CheckResult, string]> {
    const name = "Reaches the timing engine";
    const get = (): Promise<DebugTimerInfo | null> => this.engineTimerInfo(s.fp);
    const a = await get();
    if (!a) return [name, "skip", "timing engine state is not available"];
    if (!a.found) {
      const hint =
        this.console.transportLabel === "Bluetooth" || this.hwMode() === "slaprf_ble"
          ? "Is the Bluetooth Hub powered on and in range?"
          : s.role === 1
            ? "Is the Hub plugged into this laptop over USB-C?"
            : "Is the Hub on and plugged into this laptop over USB-C?";
      return [name, "fail", `the timing engine hasn't heard from ${s.fp}. ${hint}`];
    }
    if (!a.online || (a.msSinceSeen ?? 0) > 3000)
      return [name, "fail", `last heard ${((a.msSinceSeen ?? 0) / 1000).toFixed(0)} s ago`];
    await sleep(2000);
    const b = await get();
    const perSec = b ? (b.framesRx - a.framesRx) / 2 : 0;
    if (b && b.framesRx > a.framesRx) return [name, "pass", `online as timer ${a.timerId}, ${perSec.toFixed(0)} frames/s`];
    if (!a.framesRx) return [name, "pass", `online as timer ${a.timerId} (not on the track, so frames aren't counted)`];
    return [name, "fail", `online but no new frames in 2 s`];
  }

  private async runRhSelfTest(): Promise<void> {
    this.checks = [];
    this.reportExtra = "";
    this.checksAt = new Date();
    if (this.scanLive && this.isRotorHazardUSBMode()) {
      this.scanLive = false;
      this.scanToggleAt = Date.now();
      await this.runRhUsbScanCommand("stop").catch(() => undefined);
      this.renderScan();
    }
    const add = (name: string, result: CheckResult, detail: string) => {
      this.checks.push({ name, result, detail });
      this.renderSelfTest();
    };

    const isUSB = this.isRotorHazardUSBMode();
    this.setProgress(isUSB ? "Checking RotorHazard USB serial link…" : "Checking RotorHazard Socket.IO link…");
    await this.tickNonSlapRFTelemetry();
    const snap0 = this.activeRhSnapshot();
    if (!snap0 || !snap0.connected) {
      add(
        isUSB ? "USB serial link" : "Socket.IO link",
        "fail",
        snap0
          ? `${snap0.label} (${snap0.portName || snap0.endpoint}) is offline. Click Connect timer or connect on the Network page.`
          : "No RotorHazard timer connected. Click Connect timer to link a RotorHazard device."
      );
      return;
    }

    const nCount = snap0.nodeCount === 4 ? 4 : 8;
    if (isUSB) {
      add(
        "USB serial link",
        "pass",
        `${snap0.label} connected on ${snap0.portName || snap0.endpoint} (${this.store?.simulatorRunning ? "Simulated USB serial pipe" : "Native USB serial"} · ${snap0.baudRate || 115200} baud)`
      );
      add(
        "Protocol & nodes",
        "pass",
        `RotorHazard Serial API ${snap0.apiLevel || 36} · ${nCount} receiver nodes (direct read/write)`
      );
    } else {
      add(
        "Socket.IO link",
        "pass",
        `${snap0.label} connected at ${snap0.endpoint} (${snap0.transport === "sim" ? "Simulated RotorHazard server" : "Engine.IO v4 WebSocket"})`
      );

      add(
        "Admin auth",
        snap0.authOk ? "pass" : "warn",
        snap0.authOk
          ? "HTTP Basic Auth verified (read/write node frequencies & race stage control)"
          : "Connected as Guest (read-only) · sign in with admin credentials on Network page to push frequencies"
      );

      add(
        "Server & nodes",
        "pass",
        `RotorHazard ${snap0.serverVersion || "4.x"}${snap0.serverHostname ? ` (${snap0.serverHostname})` : ""} · ${nCount} RX5808 receiver nodes`
      );
    }

    const tempDebugEnabled = !this.rhLiveOn && snap0.nodeFreqsMhz.slice(0, nCount).every((f) => !f || f <= 0);
    if (tempDebugEnabled) {
      await this.syncRhDebugStream(true, snap0.timerId);
    }
    try {
      const snapTuned = this.activeRhSnapshot() ?? snap0;
      let activeNodes = 0;
      let badHysteresis = 0;
      for (let i = 0; i < nCount; i++) {
        const f = snapTuned.nodeFreqsMhz[i] ?? 0;
        if (f > 0) {
          activeNodes++;
          const ent = snapTuned.nodeEnterLevels[i] ?? 90;
          const ext = snapTuned.nodeExitLevels[i] ?? 70;
          if (ent <= ext || ext <= 0) badHysteresis++;
        }
      }
      if (activeNodes === 0) {
        add("Node RF tuning", "warn", `0 of ${nCount} nodes have an active frequency (> 0 MHz)`);
      } else if (badHysteresis > 0) {
        add("Node RF tuning", "warn", `${badHysteresis} active node(s) have EnterAt ≤ ExitAt hysteresis`);
      } else {
        const e0 = snapTuned.nodeEnterLevels[0] ?? 90;
        const x0 = snapTuned.nodeExitLevels[0] ?? 70;
        add("Node RF tuning", "pass", `${activeNodes}/${nCount} nodes tuned · Enter/Exit hysteresis valid (e.g. ${e0}/${x0} RSSI)`);
      }

      add(
        "Clock sync",
        snapTuned.clockSynced ? "pass" : "warn",
        snapTuned.clockSynced
          ? `Synced · offset ${snapTuned.clockOffsetMs >= 0 ? "+" : ""}${snapTuned.clockOffsetMs.toFixed(1)} ms`
          : "Clock sync pending"
      );

      this.setProgress("Measuring ~10 Hz heartbeat stream…");
      const hb0 = snapTuned.heartbeatsRx;
      const t0 = performance.now();
      for (let k = 0; k < 6; k++) {
        await sleep(200);
        await this.tickNonSlapRFTelemetry();
      }
      const snap1 = this.activeRhSnapshot() ?? snapTuned;
      const dtSec = Math.max(0.2, (performance.now() - t0) / 1000);
      const hbRate = Math.max(0, (snap1.heartbeatsRx - hb0) / dtSec);
      add(
        "Heartbeat stream",
        hbRate >= 4 ? "pass" : hbRate > 0 ? "warn" : "fail",
        `${hbRate.toFixed(1)} heartbeats/s (${snap1.heartbeatsRx} total, ${snap1.passesRx} passes rx)`
      );

      let minHeadroom = 999;
      let worstNode = 1;
      for (let i = 0; i < nCount; i++) {
        const f = snap1.nodeFreqsMhz[i] ?? 0;
        if (f <= 0 || snap1.crossingFlag[i]) continue;
        const ent = snap1.nodeEnterLevels[i] ?? 90;
        const cur = snap1.slotRssi[i] ?? 0;
        const hr = ent - cur;
        if (hr < minHeadroom) {
          minHeadroom = hr;
          worstNode = i + 1;
        }
      }
      if (minHeadroom === 999) {
        add("Baseline headroom", "pass", "Active nodes currently crossing or idle");
      } else if (minHeadroom < 12) {
        add(
          "Baseline headroom",
          "warn",
          `Node ${worstNode} baseline is within ${minHeadroom} RSSI of EnterAt (risk of false triggers)`
        );
      } else {
        add(
          "Baseline headroom",
          "pass",
          `≥ ${minHeadroom} RSSI headroom below EnterAt across non-crossing nodes`
        );
      }
    } finally {
      if (tempDebugEnabled && !this.rhLiveOn) {
        await this.syncRhDebugStream(false, snap0.timerId);
      }
    }
  }

  private reportText(): string {
    if (this.isRotorHazardMode()) {
      const snap = this.activeRhSnapshot();
      const lines = [
        `SlapRF · RotorHazard self-test · ${this.checksAt?.toISOString() ?? ""}`,
        snap
          ? `${snap.label} · ${snap.endpoint} · RotorHazard ${snap.serverVersion || "—"} · ${snap.nodeCount} nodes · ${snap.authOk ? "Auth OK" : "Guest"}`
          : "",
        snap?.envSummary ? `Environment: ${snap.envSummary}` : "",
        "",
        ...this.checks.map((c) => `[${c.result.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`),
      ].filter((l, i) => i === 3 || l.length > 0);
      return lines.join("\n") + this.reportExtra + "\n";
    }
    const s = this.status;
    const lines = [
      `SlapRF self-test · ${this.checksAt?.toISOString() ?? ""}`,
      s ? `${s.label || "(unnamed)"} · ${s.role === 1 ? "Hub" : "Spoke"} · fp ${s.fp} · fw ${s.fw}` : "",
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
    this.syncHardwareModeDom();
    this.renderConnection();
    this.renderSelfTest();
    this.renderStatus();
    this.renderNetworkView();
    this.renderLiveHead();
    this.renderLive();
    this.renderChannels();
    this.renderSignalControls();
    this.renderNoiseTable();
    if (this.hasSpectrumScanSupport()) {
      this.renderScan();
    }
    if (this.isSlapRFMode()) {
      this.renderSerialConsole();
      this.renderLog();
    }
    this.dirtySignal = true;
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
    this.dirtyHealth = true;
  }

  private renderBusy(): void {
    this.renderConnection();
    this.renderSelfTest();
    this.renderStatus();
    this.renderNetworkView();
    if (this.isSlapRFMode()) {
      this.renderSerialConsole();
    }
  }

  private renderConnection(): void {
    const host = this.el.querySelector<HTMLElement>('[data-slot="connection"]');
    if (!host) return;
    if (this.isRotorHazardMode()) {
      const isUSB = this.isRotorHazardUSBMode();
      const snaps = this.getRhSnapshots();
      const activeSnap = this.activeRhSnapshot();
      const anyConnected = snaps.some((s) => s.connected);
      const liveLedColor = getAppTheme() === "light" ? "#3b82f6" : "#d4ff3a";
      const chipsHtml = snaps
        .map((s) => {
          const isSel = activeSnap?.timerId === s.timerId;
          const chipColor = !s.connected ? "#64748b" : s.authOk ? liveLedColor : "#facc15";
          const epLbl = isUSB ? s.portName || s.endpoint : s.endpoint;
          const meta = s.connected
            ? isUSB
              ? `${epLbl} · ${s.nodeCount}N · API ${s.apiLevel || 36}`
              : `${epLbl} · ${s.nodeCount}N · ${s.authOk ? "Auth OK" : "Guest"}`
            : `${epLbl} · Offline`;
          const quickConnectBtn =
            !s.connected && this.store?.simulatorRunning
              ? `<button type="button" class="btn btn-xs btn-armed" data-action="connect-rh-timer" data-timer-id="${s.timerId}" title="Connect ${esc(s.label)}">Connect timer</button>`
              : "";
          return `
            <div class="pilot-chip debug-usb-chip ${isSel ? "is-active" : ""}" style="--c:${chipColor}">
              <button
                type="button"
                class="debug-usb-chip-select"
                role="tab"
                aria-selected="${isSel}"
                data-action="select-rh-timer"
                data-timer-id="${s.timerId}"
                title="${esc(s.label)} (${esc(meta)})"
              >
                <span class="dot ${s.connected ? "is-live" : ""}"></span>
                <span class="pilot-chip-name">${esc(s.label)}</span>
                <span class="pilot-chip-time">${esc(meta)}</span>
              </button>
              ${quickConnectBtn}
            </div>`;
        })
        .join("");

      const actionLabel = anyConnected ? "Manage timers" : "Connect timer";
      const errHtml = this.error ? `<div class="sim-error-note">${esc(this.error)}</div>` : "";
      const btnTitle = isUSB
        ? "Open Network page to connect RotorHazard USB serial nodes"
        : "Open Network page to connect or sign in to RotorHazard timers";
      host.innerHTML = `
        <div class="picker-row debug-usb-picker-row">
          <div class="pilot-picker debug-usb-picker" role="tablist" aria-label="Active timer connection">
            ${chipsHtml}
            <button
              type="button"
              class="pilot-chip debug-usb-add-chip"
              data-action="go-network-timers"
              title="${btnTitle}"
            >
              ${isUSB ? icons.plug(18) : icons.wifi(18)}
              <span class="pilot-chip-name">${actionLabel}</span>
            </button>
          </div>
        </div>
        ${errHtml}`;
      return;
    }

    if (this.isLapRFMode()) {
      const snaps = this.store ? sharedLapRFLink.snapshots(this.store) : [];
      const anyConnected = snaps.some((s) => s.connected);
      const liveLedColor = getAppTheme() === "light" ? "#3b82f6" : "#d4ff3a";
      const chipsHtml = snaps
        .map((s, idx) => {
          const chipColor = s.connected ? liveLedColor : "#64748b";
          const meta = s.connected ? `${s.endpoint} · Online` : `${s.endpoint} · Offline`;
          return `
            <div class="pilot-chip debug-usb-chip ${idx === 0 ? "is-active" : ""}" style="--c:${chipColor}">
              <span class="debug-usb-chip-select">
                <span class="dot ${s.connected ? "is-live" : ""}"></span>
                <span class="pilot-chip-name">${esc(s.label)}</span>
                <span class="pilot-chip-time">${esc(meta)}</span>
              </span>
            </div>`;
        })
        .join("");
      host.innerHTML = `
        <div class="picker-row debug-usb-picker-row">
          <div class="pilot-picker debug-usb-picker" role="tablist" aria-label="Active timer connection">
            ${chipsHtml}
            <button
              type="button"
              class="pilot-chip debug-usb-add-chip"
              data-action="go-network-timers"
              title="Open Network page to connect LapRF 8-Way timers"
            >
              ${icons.wifi(18)}
              <span class="pilot-chip-name">${anyConnected ? "Manage timers" : "Connect timer"}</span>
            </button>
          </div>
        </div>`;
      return;
    }

    const isBleMode = this.hwMode() === "slaprf_ble";
    patchUsbConnectionBar(host, {
      activeConsole: this.console,
      showAllPorts: isBleMode ? false : this.showAllPorts,
      bluetoothMode: isBleMode,
      allowSwap: true,
      busyText: this.busy,
      error: this.error,
    });
  }

  private renderSelfTest(): void {
    if (this.isRotorHazardMode()) {
      const snap = this.activeRhSnapshot();
      const on = Boolean(snap?.connected);
      const running = this.busy === "Self-test";
      const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
      for (const c of this.checks) counts[c.result]++;
      const ledClass = running
        ? "is-warn"
        : this.checks.length
          ? counts.fail
            ? "is-bad"
            : counts.warn
              ? "is-warn"
              : "is-up"
          : on
            ? snap?.authOk
              ? "is-up"
              : "is-warn"
            : "";
      const summary = this.checks.length
        ? running
          ? esc(this.progress)
          : counts.fail
            ? `${counts.fail} problem${counts.fail > 1 ? "s" : ""} found`
            : counts.warn
              ? `Passed with ${counts.warn} warning${counts.warn > 1 ? "s" : ""}`
              : `All ${this.checks.length} checks passed`
        : running
          ? esc(this.progress)
          : on
            ? `<span class="debug-hint-desktop">Ready · ${esc(snap!.label)} (${esc(snap!.endpoint)}) · ~1.5 s non-intrusive check</span><span class="debug-hint-mobile">Ready · ${esc(snap!.label)} · ~1.5 s</span>`
            : `<span class="debug-hint-desktop">Off · click Connect timer above</span><span class="debug-hint-mobile">Off · not connected</span>`;
      const consoleLines = this.checks.length
        ? esc(
            this.checks
              .map((c) => {
                const tag =
                  c.result === "pass"
                    ? "[PASS]"
                    : c.result === "warn"
                      ? "[WARN]"
                      : c.result === "fail"
                        ? "[FAIL]"
                        : "[SKIP]";
                return `${tag}  ${c.name.padEnd(20, " ")}  ${c.detail}`;
              })
              .join("\n")
          )
        : esc(
            running
              ? this.progress || "Starting RotorHazard self-test..."
              : on
                ? this.isRotorHazardUSBMode()
                  ? `# Click "Run self-test" to verify ${snap!.label} USB serial link (API ${snap!.apiLevel || 36}), receiver node tuning, serial RTT, and ~10 Hz RSSI stream.`
                  : `# Click "Run self-test" to verify ${snap!.label} Socket.IO link, HTTP Basic Auth, RX5808 node tuning, clock sync, and ~10 Hz heartbeat stream.`
                : "# Connect a RotorHazard timer above or on the Network page to run the hardware self-test."
          );
      this.slot("selftest").innerHTML = `
        <div class="debug-card-head debug-log-head">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}"></span>
            <span class="debug-head-note">${summary}</span>
          </span>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="copy-report" ${this.checks.length && !running ? "" : "disabled"} title="Copy self-test report" aria-label="Copy self-test report">${icons.copy(17)}</button>
            <button type="button" class="btn btn-sm btn-armed debug-selftest-run-btn" data-action="selftest" ${on && !this.busy ? "" : "disabled"} title="${running ? "Running self-test…" : "Run self-test"}" aria-label="${running ? "Running self-test…" : "Run self-test"}">
              ${icons.bug(14)}<span class="debug-hint-desktop">${running ? "Testing…" : "Run self-test"}</span>
            </button>
          </div>
        </div>
        <div class="table-scroll">
          <pre class="debug-log debug-selftest-log mono">${consoleLines}</pre>
        </div>`;
      return;
    }

    const on = this.console.connected;
    const running = this.busy === "Self-test";
    const emg = Boolean(on && this.status?.emergencyMode);
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of this.checks) counts[c.result]++;
    const isOther = Boolean(on && this.console.isOtherDevice);
    const ledClass = running
      ? "is-warn"
      : emg || isOther
        ? "is-emergency"
        : this.checks.length
          ? counts.fail
            ? "is-bad"
            : counts.warn
              ? "is-warn"
              : "is-up"
          : on
            ? this.status?.role === 2
              ? "is-spoke"
              : "is-up"
            : "";
    const summary = this.checks.length
      ? running
        ? esc(this.progress)
        : counts.fail
          ? `${counts.fail} problem${counts.fail > 1 ? "s" : ""} found`
          : counts.warn
            ? `Passed with ${counts.warn} warning${counts.warn > 1 ? "s" : ""}`
            : `All ${this.checks.length} checks passed`
      : running
        ? esc(this.progress)
        : emg
          ? `<span class="debug-hint-desktop">Emergency mode active · exit emergency mode to run 5.8 GHz RF checks</span><span class="debug-hint-mobile">Emergency mode active</span>`
          : isOther
            ? `<span class="debug-hint-desktop">Connected XIAO ESP32-C5 (Other) has no SlapRF firmware · open Flasher to write firmware</span><span class="debug-hint-mobile">No SlapRF firmware · open Flasher</span>`
            : on
              ? `<span class="debug-hint-desktop">Ready · takes about 10 s (pauses timing briefly during scan)</span><span class="debug-hint-mobile">Ready · ~10 s check</span>`
              : `<span class="debug-hint-desktop">Off · click Connect in the top bar</span><span class="debug-hint-mobile">Off · not connected</span>`;
    const consoleLines = this.checks.length
      ? esc(
          this.checks
            .map((c) => {
              const tag = c.result === "pass" ? "[PASS]" : c.result === "warn" ? "[WARN]" : c.result === "fail" ? "[FAIL]" : "[SKIP]";
              return `${tag}  ${c.name.padEnd(20, " ")}  ${c.detail}`;
            })
            .join("\n")
        )
      : esc(
          running
            ? this.progress || "Starting self-test..."
            : emg
              ? "# Timer is in Emergency Mode (radio and 50 Hz sweeps halted for rescue/reflashing). Click \"Exit emergency mode\" before running RF self-tests."
              : on
                ? "# Click \"Run self-test\" to verify console, identity, 5.8 GHz receiver, sweep timing, memory, and course link."
                : this.hwMode() === "slaprf_ble"
                  ? "# Connect a SlapRF Bluetooth Hub above or in the top bar to run the hardware self-test."
                  : "# Connect a timer over USB-C in the top bar to run the hardware self-test."
        );
    this.slot("selftest").innerHTML = `
      <div class="debug-card-head debug-log-head">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="debug-head-note">${summary}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="copy-report" ${this.checks.length && !running ? "" : "disabled"} title="Copy self-test report" aria-label="Copy self-test report">${icons.copy(17)}</button>
          <button type="button" class="btn btn-sm btn-armed debug-selftest-run-btn" data-action="selftest" ${on && !this.busy ? "" : "disabled"} title="${running ? "Running self-test…" : "Run self-test"}" aria-label="${running ? "Running self-test…" : "Run self-test"}">
            ${icons.bug(14)}<span class="debug-hint-desktop">${running ? "Testing…" : "Run self-test"}</span>
          </button>
        </div>
      </div>
      <div class="table-scroll">
        <pre class="debug-log debug-selftest-log mono">${consoleLines}</pre>
      </div>`;
  }

  private renderStatus(): void {
    if (this.isRotorHazardMode()) {
      const isUSB = this.isRotorHazardUSBMode();
      const snap = this.activeRhSnapshot();
      const on = Boolean(snap?.connected);
      const nCount = snap?.nodeCount === 4 ? 4 : 8;
      const ledClass = on ? (snap!.authOk ? "is-up" : "is-warn") : "";
      const gateNode = snap
        ? (this.store?.nodes ?? []).find((g) => g.assignedTimerId === snap.timerId)
        : undefined;
      const gateName = gateNode
        ? gateNode.name?.trim() || `Gate ${(gateNode.trackOrder ?? 0) + 1}`
        : "Unassigned";

      let activeNodeCount = 0;
      const nodeChips: string[] = [];
      for (let i = 0; i < nCount; i++) {
        const f = snap?.nodeFreqsMhz[i] ?? 0;
        if (f > 0) activeNodeCount++;
        const band = f > 0 ? hardwareBandLabel(f) : "";
        const onCh = Boolean(this.signalEnabledCh[i]) && f > 0;
        nodeChips.push(
          `<span class="debug-status-ch mono ${onCh ? "" : "is-muted"}" title="Node ${i + 1}: ${f > 0 ? formatHardwareFreq(f) : "Disabled"}"><strong>N${i + 1}</strong> ${f > 0 ? (band ? `${band} ${f}` : `${f}`) : "Off"}</span>`
        );
      }

      const e0 = snap?.nodeEnterLevels[0] ?? 90;
      const x0 = snap?.nodeExitLevels[0] ?? 70;
      const epStr = snap ? (isUSB ? snap.portName || snap.endpoint : snap.endpoint) : "";
      const headText =
        on && snap
          ? isUSB
            ? `${esc(snap.label)} · ${esc(epStr)} · API ${snap.apiLevel || 36} (${snap.baudRate || 115200} baud) · ${nCount} nodes · ${snap.gateArmed ? "Gate armed" : "Standby"}`
            : `${esc(snap.label)} · ${esc(epStr)} · RotorHazard ${esc(snap.serverVersion || "4.x")} · ${nCount} nodes · ${snap.gateArmed ? "Gate armed" : "Standby"}`
          : snap
            ? `${esc(snap.label)} (${esc(epStr)}) · Offline`
            : "Off · click Connect timer above";

      const healthTitle = this.el.querySelector<HTMLElement>("[data-health-title]");
      if (healthTitle) {
        healthTitle.classList.toggle("is-active", on);
      }

      const protoBadge = !snap
        ? "-"
        : isUSB
          ? `USB API ${snap.apiLevel || 36}`
          : snap.transport === "sim"
            ? "Sim RH"
            : "Socket.IO";

      this.slot("status").innerHTML = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}"></span>
            <span class="debug-head-note">${headText}</span>
          </span>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="refresh-status" ${on && !this.busy ? "" : "disabled"} title="Refresh RotorHazard status" aria-label="Refresh status">
              ${icons.reset(17)}
            </button>
          </div>
        </div>
        <div class="debug-status-panels">
          <div class="debug-subbox">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title ${on ? "is-active" : ""}">${icons.cpu(14)}<span>${isUSB ? "Timer &amp; USB link" : "Timer &amp; server"}</span></span>
              <span class="badge mono">${protoBadge}</span>
            </div>
            <dl class="debug-kv-list">
              <div class="debug-kv-row">
                <dt>Timer</dt>
                <dd>${snap ? `<strong>${esc(snap.label)}</strong> <span class="note">· ${esc(gateName)}</span>` : "-"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>${isUSB ? "Serial port" : "Endpoint"}</dt>
                <dd>${snap ? `<span class="mono">${esc(epStr)}</span>` : "-"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>${isUSB ? "Serial API" : "Server version"}</dt>
                <dd>${on && snap ? (isUSB ? `<span class="mono">API ${snap.apiLevel || 36} · ${snap.baudRate || 115200} baud</span>` : `<span class="mono">RotorHazard ${esc(snap.serverVersion || "4.x")}</span>`) : "-"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>${isUSB ? "Firmware" : "Hostname"}</dt>
                <dd>${on && snap ? `<span class="mono">${esc(isUSB ? snap.serverVersion || `API ${snap.apiLevel || 36}` : snap.serverHostname || "rotorhazard-pi")}</span>` : "-"}</dd>
              </div>
            </dl>
          </div>

          <div class="debug-subbox">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title ${on ? "is-active" : ""}">${icons.signal(14)}<span>Receiver nodes</span></span>
              ${!on ? `<span class="badge">-</span>` : snap?.gateArmed ? `<span class="badge badge-good">Armed</span>` : `<span class="badge">Standby</span>`}
            </div>
            <dl class="debug-kv-list">
              <div class="debug-kv-row">
                <dt>Active nodes</dt>
                <dd>${on ? `${activeNodeCount} of ${nCount} tuned <span class="note">· ~10 Hz ${isUSB ? "poll" : "heartbeat"}</span>` : "-"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Hysteresis</dt>
                <dd>${on ? `<span class="mono">Enter ${e0} · Exit ${x0}</span> <span class="note">(0-255 RSSI)</span>` : "-"}</dd>
              </div>
              <div class="debug-kv-row is-channels-row">
                <dt>Nodes</dt>
                <dd class="debug-status-ch-grid">${nodeChips.join("")}</dd>
              </div>
            </dl>
          </div>

          <div class="debug-subbox">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title ${on ? "is-active" : ""}">${isUSB ? icons.plug(14) : icons.wifi(14)}<span>Link, clock &amp; sensors</span></span>
              ${!on ? `<span class="badge">—</span>` : isUSB ? `<span class="badge badge-good">Direct USB</span>` : snap?.authOk ? `<span class="badge badge-good">Auth OK</span>` : `<span class="badge badge-warn">Guest</span>`}
            </div>
            <dl class="debug-kv-list">
              <div class="debug-kv-row">
                <dt>${isUSB ? "Serial RTT" : "Clock sync"}</dt>
                <dd class="mono" data-rh-live-clock>${on && snap ? `${snap.clockSynced ? "Synced" : "Syncing"} · ${snap.clockOffsetMs >= 0 ? "+" : ""}${snap.clockOffsetMs.toFixed(1)} ms` : "—"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Telemetry rx</dt>
                <dd class="mono" data-rh-live-telem>${on && snap ? `${snap.heartbeatsRx} ${isUSB ? "polls" : "heartbeats"} · ${snap.passesRx} passes` : "—"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Environment</dt>
                <dd data-rh-live-env>${on && snap ? esc(snap.envSummary || (snap.cpuTempC && snap.cpuTempC > 0 ? `Pi CPU ${snap.cpuTempC.toFixed(1)} °C` : "No sensor reported")) : "—"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Access role</dt>
                <dd>${on && snap ? (isUSB ? "Direct USB serial (read/write)" : snap.authOk ? "HTTP Basic Auth (admin)" : "Guest (read-only)") : "—"}</dd>
              </div>
            </dl>
          </div>
        </div>`;
      return;
    }

    const on = this.console.connected;
    const s = this.status;
    const budget = s ? s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0) : 0;
    const badReset = s ? BAD_RESETS.includes(s.reset) : false;
    const unprov = s ? s.fp.toUpperCase() === UNPROVISIONED_FP : false;
    const ledClass =
      on && s
        ? s.emergencyMode
          ? "is-emergency"
          : s.role === 2
            ? "is-spoke"
            : "is-up"
        : on
          ? this.console.isOtherDevice
            ? "is-emergency"
            : "is-warn"
          : "";
    const headText = s
      ? s.emergencyMode
        ? (s.crashStreak ?? 0) > 0
          ? `Emergency mode · halted after ${s.crashStreak} consecutive ${esc(s.reset)} resets (radio off, ready for rescue or reflash)`
          : `Emergency mode · forced manually (radio off, ambulance LED fade active · click Exit emergency mode to resume)`
        : `${esc(s.label || "(unnamed)")} · ${s.role === 1 ? "Hub" : `Spoke${s.slot ? ` · slot ${s.slot}` : ""}`} · polling every 2 s · up ${fmtUptime(s.uptimeMs)}`
      : on
        ? this.console.isOtherDevice
          ? "Connected device (Other) has no SlapRF firmware · open Flasher to write firmware"
          : "Waiting for timer status…"
        : "Off · click Connect in the top bar";

    const rfBadge = !s
      ? `<span class="badge">—</span>`
      : s.emergencyMode
        ? `<span class="badge badge-bad">Emergency mode</span>`
        : !s.rf.ok
          ? `<span class="badge badge-bad">Boot check failed</span>`
          : s.scanLive
            ? `<span class="badge badge-accent">Live scan</span>`
            : !s.rf.enabled
              ? `<span class="badge">Standby</span>`
              : `<span class="badge badge-good">OK</span>`;

    const freqs = s?.freqs ?? RACEBAND;
    const chChips = freqs
      .map((f, i) => {
        const rb = racebandName(f) || `Ch${i + 1}`;
        const onCh = this.signalEnabledCh[i];
        return `<span class="debug-status-ch mono ${onCh ? "" : "is-muted"}" title="${onCh ? `Slot ${i + 1}: ${rb} (${f} MHz) · monitored` : `Slot ${i + 1}: ${rb} (${f} MHz) · disabled`}"><strong>${rb}</strong> ${f}</span>`;
      })
      .join("");

    const active = Boolean(on && s);
    const healthTitle = this.el.querySelector<HTMLElement>("[data-health-title]");
    if (healthTitle) {
      healthTitle.classList.toggle("is-active", active);
    }

    this.slot("status").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="debug-head-note">${headText}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="read-config" ${on && !this.busy ? "" : "disabled"} title="Read SLAPRF02 config block (SLAPRF?)" aria-label="Read config">${icons.sliders(17)}</button>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="refresh-status" ${on && !this.busy ? "" : "disabled"} title="Refresh timer status (STATUS?)" aria-label="Refresh status">
            ${icons.reset(17)}
          </button>
        </div>
      </div>
      <div class="debug-status-panels">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${active ? "is-active" : ""}">${icons.cpu(14)}<span>Identity &amp; hardware</span></span>
            <span class="badge ${unprov ? "badge-warn" : "mono"}">${s ? (unprov ? `${esc(s.fp)} · not set up` : esc(s.fp)) : "—"}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Timer</dt>
              <dd>${s ? `${esc(s.label || "(unnamed)")} <span class="note">· ${s.role === 1 ? "Hub" : `Spoke${s.slot ? ` · slot ${s.slot}` : ""}`}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware</dt>
              <dd>${s ? `<span class="mono">${esc(s.fw)}</span>` : "—"}</dd>
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
            <span class="debug-subbox-title ${active && s?.rf.ok && s?.rf.enabled ? "is-active" : ""}">${icons.signal(14)}<span>5.8 GHz receiver</span></span>
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
                !s
                  ? "—"
                  : !s.rf.enabled
                    ? `<span class="note">Standby · active while streaming or scanning</span>`
                    : `${s.sweepHz} Hz · ${(s.sweepUs / 1000).toFixed(2)} ms <span class="note">(max <span class="${budget && s.sweepUsMax > budget ? "debug-tone-warn" : ""}">${(s.sweepUsMax / 1000).toFixed(2)} ms</span> / ${(budget / 1000).toFixed(1)} ms)</span>`
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
            <span class="debug-subbox-title ${active ? "is-active" : ""}">${icons.wifi(14)}<span>${s?.ble || this.isSlapRFBLEMode() || this.console.transportLabel === "Bluetooth" ? "System &amp; Bluetooth" : "System &amp; network"}</span></span>
            <span class="badge">${
              s?.ble
                ? s.ble.pairingMode
                  ? "Pairing mode"
                  : s.ble.paired === false
                    ? "Unpaired"
                    : "BLE Paired"
                : this.isSlapRFBLEMode() || this.console.transportLabel === "Bluetooth"
                  ? on
                    ? "BLE Paired"
                    : "Bluetooth"
                  : s
                    ? `Ch ${s.channel}`
                    : "-"
            }</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Uptime</dt>
              <dd>${s ? `${fmtUptime(s.uptimeMs)} <span class="note">· boot #${s.boots ?? "?"}</span>` : "-"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Last restart</dt>
              <dd>${
                s
                  ? s.emergencyMode
                    ? `<span class="badge badge-bad">Emergency mode</span> ${esc(s.reset)}${(s.crashStreak ?? 0) > 0 ? ` (${s.crashStreak}× in a row)` : ""}`
                    : badReset
                      ? `${esc(s.reset)} <span class="note">· see boot log</span>`
                      : esc(s.reset)
                  : "-"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Memory free</dt>
              <dd>${s ? `${(s.heapFree / 1024).toFixed(0)} KB <span class="note">· lowest ${(s.heapMin / 1024).toFixed(0)} KB</span>` : "-"}</dd>
            </div>
            ${
              s?.ble
                ? `<div class="debug-kv-row" data-ble-link-row>
                     <dt>Bluetooth link</dt>
                     <dd><span class="mono">${(s.ble.intervalUs / 1000).toFixed(2).replace(/\.00$/, "")} ms</span>${s.ble.rssi ? ` · <span class="mono">${s.ble.rssi} dBm</span>` : ""} <span class="note">· MTU ${s.ble.mtu}${s.ble.phy ? ` · ${s.ble.phy}M PHY` : ""}</span></dd>
                   </div>
                   <div class="debug-kv-row" data-ble-sync-row>
                     <dt>BLE radio window</dt>
                     <dd>${s.ble.syncLocked ? `Phase locked <span class="note">· ${s.ble.phaseUs} us</span>` : "73% 2.4 GHz open"} <span class="note">· drops ${s.ble.txDrops}</span></dd>
                   </div>
                   <div class="debug-kv-row" data-ble-pair-row>
                     <dt>BLE pairing</dt>
                     <dd>${s.ble.pairingMode ? "Open pairing mode" : s.ble.paired === false ? "Unpaired" : "Paired to host"}</dd>
                   </div>`
                : this.isSlapRFBLEMode() || this.console.transportLabel === "Bluetooth"
                  ? `<div class="debug-kv-row" data-ble-link-row>
                       <dt>Bluetooth link</dt>
                       <dd>${on ? "Connected" : "Idle"}</dd>
                     </div>`
                  : `<div class="debug-kv-row">
                       <dt>Course link</dt>
                       <dd>${
                         s
                           ? s.role === 1
                             ? `Hub · Ch ${s.channel}`
                             : s.slot >= 2
                               ? `Joined Hub · slot ${s.slot}`
                               : "Not joined to a Hub"
                           : "-"
                       }</dd>
                     </div>`
            }
          </dl>
        </div>
      </div>`;
  }

  private renderNetworkView(): void {
    const netSlot = this.el.querySelector<HTMLElement>('[data-slot="network"]');
    if (!netSlot) return;
    const on = this.console.connected;
    const s = this.status;
    const knownTimers = getKnownHardwareTimers();
    const realServerTimers = this.serverTimers.filter(
      (t) => !(t.fingerprint || "").toUpperCase().startsWith("SIM000")
    );

    if (!on || !s) {
      const emptySlots = Array.from({ length: 6 }, (_, i) => {
        const slotNum = i + 2;
        return `
          <div class="debug-net-slot-card is-empty">
            <div class="debug-net-slot-head">
              <span class="debug-net-slot-num mono">TDMA Slot ${slotNum}</span>
              <span class="note">Open</span>
            </div>
            <div class="debug-net-slot-body">
              <span class="note">Child Spoke S${i + 1}</span>
            </div>
          </div>`;
      }).join("");

      this.slot("network").innerHTML = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${on ? "is-warn" : ""}"></span>
            <span class="debug-head-note">${on ? "Reading timer network role…" : "Off · connect a Hub or Spoke over USB to inspect its parent/child network links"}</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge">—</span>
          </div>
        </div>
        <div class="debug-network-panels is-hub-view is-unread">
          <div class="debug-subbox debug-net-self-card">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title">${icons.wifi(14)}<span>Current device (Hub or Spoke)</span></span>
              <span class="badge">—</span>
            </div>
            <dl class="debug-kv-list">
              <div class="debug-kv-row">
                <dt>Network role</dt>
                <dd>—</dd>
              </div>
              <div class="debug-kv-row">
                <dt>TDMA slot</dt>
                <dd>—</dd>
              </div>
              <div class="debug-kv-row">
                <dt>2.4 GHz link</dt>
                <dd>—</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Schedule</dt>
                <dd>—</dd>
              </div>
            </dl>
          </div>
          <div class="debug-subbox debug-net-peers-card">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title">${icons.slaprf(14)}<span>Tied Parent Hub / Child Spokes (TDMA Slots 2–7)</span></span>
              <span class="badge">—</span>
            </div>
            <div class="debug-net-slot-grid">${emptySlots}</div>
          </div>
        </div>`;
      return;
    }

    const ch = s.channel || 1;

    if (s.role === 1) {
      // Connected device is a Hub (Parent, Slot 1): show tied Child Spokes across TDMA Slots 2..7.
      interface TiedSpokeEntry {
        slot: number;
        fp: string;
        label: string;
        fw: string;
        mac?: string;
        online: boolean;
        inHubStatus: boolean;
        frames?: number;
        msAgo?: number;
        seq?: number;
        dbm?: number[];
        ratePktPerSec?: number;
        serverFrames?: number;
        serverGateLabel?: string;
        serverRssi?: number[];
        sourceNote: string;
      }
      const bySlot = new Map<number, TiedSpokeEntry>();
      const usedFps = new Set<string>([s.fp.toUpperCase()]);
      const nowMs = performance.now();

      // 1. Direct firmware STATUS? spokes if present
      if (Array.isArray(s.spokes)) {
        for (const sp of s.spokes) {
          if (sp.slot >= 2 && sp.slot <= 7) {
            const rawFp = (sp.fp || "").toUpperCase();
            const isFallbackFp = rawFp.startsWith("53504B");
            const known = !isFallbackFp && rawFp ? knownTimers.find((k) => k.fp.toUpperCase() === rawFp) : undefined;
            const fp = (!isFallbackFp && rawFp) || known?.fp || `SLOT${sp.slot}`;
            const frames = sp.frames ?? 0;
            const prevRate = this.spokeRateTracker.get(sp.slot);
            let ratePktPerSec = prevRate?.ratePktPerSec ?? 0;
            if (prevRate) {
              const dtSec = (nowMs - prevRate.atMs) / 1000;
              if (dtSec >= 0.25) {
                ratePktPerSec = frames >= prevRate.frames ? (frames - prevRate.frames) / dtSec : 0;
                this.spokeRateTracker.set(sp.slot, { frames, atMs: nowMs, ratePktPerSec });
              }
            } else {
              this.spokeRateTracker.set(sp.slot, { frames, atMs: nowMs, ratePktPerSec: 0 });
            }
            const activelyReceiving = frames > 0 && (sp.msAgo === undefined || sp.msAgo < 2500);
            const sourceNote =
              frames === 0
                ? `Joined Slot ${sp.slot} · 0 frames rx`
                : sp.msAgo !== undefined && sp.msAgo >= 2500
                  ? `Stale (${(sp.msAgo / 1000).toFixed(1)}s ago) · ${frames} frames`
                  : `${frames} frames rx · ${ratePktPerSec.toFixed(1)} pkt/s`;
            bySlot.set(sp.slot, {
              slot: sp.slot,
              fp,
              label: sp.label || known?.label || `T${sp.slot - 1}`,
              fw: sp.fw || known?.fw || s.fw,
              mac: sp.mac || known?.mac,
              online: activelyReceiving,
              inHubStatus: true,
              frames,
              msAgo: sp.msAgo,
              seq: sp.seq,
              dbm: sp.dbm,
              ratePktPerSec,
              sourceNote,
            });
            if (!isFallbackFp && rawFp) usedFps.add(rawFp);
          }
        }
      }

      // 2. Real timers from the in-browser real-world engine (/v1/state via WASM)
      for (const dt of realServerTimers) {
        if (!dt.isHub && dt.timerId >= 2 && dt.timerId <= 7) {
          const fp = (dt.fingerprint || "").toUpperCase();
          const gate = this.serverGates.find((g) => g.assignedTimerId === dt.timerId);
          const gateName = gate ? (gate.name?.trim() || gate.timerLabel?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
          const serverFrames = gate?.framesRxCount ?? 0;
          const serverRssi = Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined;
          if (bySlot.has(dt.timerId)) {
            const cur = bySlot.get(dt.timerId)!;
            cur.serverFrames = serverFrames;
            cur.serverGateLabel = gateName;
            cur.serverRssi = serverRssi;
            if (fp && (cur.fp.startsWith("SLOT") || cur.fp.startsWith("53504B"))) {
              cur.fp = fp;
            }
            if (dt.timerLabel && cur.label === `T${dt.timerId - 1}`) {
              cur.label = dt.timerLabel;
            }
            if (fp) usedFps.add(fp);
            continue;
          }
          if (fp && usedFps.has(fp)) continue;
          const known = fp ? knownTimers.find((k) => k.fp === fp) : undefined;
          const prevRate = this.spokeRateTracker.get(dt.timerId);
          let ratePktPerSec = prevRate?.ratePktPerSec ?? 0;
          if (prevRate) {
            const dtSec = (nowMs - prevRate.atMs) / 1000;
            if (dtSec >= 0.25) {
              ratePktPerSec = serverFrames >= prevRate.frames ? (serverFrames - prevRate.frames) / dtSec : 0;
              this.spokeRateTracker.set(dt.timerId, { frames: serverFrames, atMs: nowMs, ratePktPerSec });
            }
          } else {
            this.spokeRateTracker.set(dt.timerId, { frames: serverFrames, atMs: nowMs, ratePktPerSec: 0 });
          }
          const serverOnline = Boolean(dt.online && serverFrames > 0);
          bySlot.set(dt.timerId, {
            slot: dt.timerId,
            fp: fp || "—",
            label: dt.timerLabel || known?.label || `T${dt.timerId - 1}`,
            fw: dt.firmwareVersion || known?.fw || s.fw,
            mac: known?.mac,
            online: serverOnline,
            inHubStatus: false,
            frames: serverFrames,
            ratePktPerSec,
            serverFrames,
            serverGateLabel: gateName,
            serverRssi,
            sourceNote: serverOnline
              ? `${serverFrames} samples on server`
              : `0 frames rx · not heard by Hub`,
          });
          if (fp) usedFps.add(fp);
        }
      }

      // 3. Hardware registry Spokes tied to this Hub
      const candidateSpokes = knownTimers.filter(
        (k) =>
          k.role === "spoke" &&
          !usedFps.has(k.fp.toUpperCase()) &&
          (!k.parentHubFp || k.parentHubFp.toUpperCase() === s.fp.toUpperCase())
      );
      for (const k of candidateSpokes) {
        let targetSlot = k.slot && k.slot >= 2 && k.slot <= 7 && !bySlot.has(k.slot) ? k.slot : 0;
        if (!targetSlot) {
          for (let sl = 2; sl <= 7; sl++) {
            if (!bySlot.has(sl)) {
              targetSlot = sl;
              break;
            }
          }
        }
        if (targetSlot >= 2 && targetSlot <= 7) {
          const gate = this.serverGates.find((g) => g.assignedTimerId === targetSlot);
          const gateName = gate ? (gate.name?.trim() || gate.timerLabel?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
          bySlot.set(targetSlot, {
            slot: targetSlot,
            fp: k.fp,
            label: k.label || `T${targetSlot - 1}`,
            fw: k.fw || s.fw,
            mac: k.mac,
            online: false,
            inHubStatus: false,
            frames: 0,
            ratePktPerSec: 0,
            serverFrames: gate?.framesRxCount ?? 0,
            serverGateLabel: gateName,
            serverRssi: Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined,
            sourceNote: `0 frames rx · not joined since Hub boot`,
          });
          usedFps.add(k.fp.toUpperCase());
        }
      }

      const tiedCount = bySlot.size;
      const activeRxCount = [...bySlot.values()].filter((c) => c.online).length;
      if (this.selectedNetworkSpokeSlot === null || !bySlot.has(this.selectedNetworkSpokeSlot)) {
        this.selectedNetworkSpokeSlot = [...bySlot.keys()][0] ?? null;
      }
      const selectedSlot = this.selectedNetworkSpokeSlot;
      const selectedChild = selectedSlot !== null ? bySlot.get(selectedSlot) : undefined;

      const ledClass = s.emergencyMode ? "is-emergency" : tiedCount > 0 && activeRxCount === 0 ? "is-warn" : "is-up";
      const topText = s.emergencyMode
        ? `${esc(s.label || "H1")} · Hub (Parent · Slot 1) · Emergency mode active (2.4 GHz beacon paused)`
        : `${esc(s.label || "H1")} · Hub (Parent · Slot 1) · ${activeRxCount}/${tiedCount} child Spoke${tiedCount === 1 ? "" : "s"} actively streaming · 2.4 GHz Ch ${ch}`;

      const slotCards = Array.from({ length: 6 }, (_, i) => {
        const slotNum = i + 2;
        const child = bySlot.get(slotNum);
        if (!child) {
          return `
            <div class="debug-net-slot-card is-empty">
              <div class="debug-net-slot-head">
                <span class="debug-net-slot-num mono">TDMA Slot ${slotNum}</span>
                <span class="note">Open</span>
              </div>
              <div class="debug-net-slot-body">
                <span class="note">Available for Spoke S${i + 1}</span>
              </div>
            </div>`;
        }
        const isSelected = slotNum === selectedSlot;
        const badgeClass = child.online ? "badge-good" : child.inHubStatus ? "badge-warn" : "";
        const badgeLabel = child.online
          ? `Receiving · Slot ${slotNum}`
          : child.inHubStatus
            ? (child.frames ?? 0) === 0
              ? `No Data · Slot ${slotNum}`
              : `Stale · Slot ${slotNum}`
            : `No Link · Slot ${slotNum}`;
        return `
          <div class="debug-net-slot-card is-assigned is-clickable ${isSelected ? "is-selected" : ""}" data-action="select-net-spoke" data-spoke-slot="${slotNum}" role="button" tabindex="0" aria-pressed="${isSelected}" title="Click to inspect live telemetry received by ${esc(s.label || "this Hub")} from ${esc(child.label)}">
            <div class="debug-net-slot-head">
              <span class="debug-net-slot-num mono">TDMA Slot ${slotNum}</span>
              <span class="badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="debug-net-slot-main">
              <div class="debug-net-slot-id">
                <span class="status-dot ${child.online ? "is-up" : "is-warn"}"></span>
                <strong>${esc(child.label)}</strong>
                <span class="note">· Child Spoke</span>
              </div>
              <span class="badge mono">${esc(child.fp)}</span>
            </div>
            <div class="debug-net-slot-meta">
              <span>${esc(child.sourceNote)}</span>
              <span class="mono">${child.mac ? `${esc(child.mac)} · ` : ""}${esc(child.fw)}</span>
            </div>
          </div>`;
      }).join("");

      const freqs = s.freqs?.length === 8 ? s.freqs : RACEBAND;
      const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
      let inspectorHtml = "";
      if (selectedChild) {
        const rate = selectedChild.ratePktPerSec ?? 0;
        const frames = selectedChild.frames ?? 0;
        const dbmSource =
          selectedChild.dbm && selectedChild.dbm.length === 8
            ? selectedChild.dbm
            : selectedChild.online && selectedChild.serverRssi && selectedChild.serverRssi.some((v) => v < 0)
              ? selectedChild.serverRssi.map((v) => Math.round(v))
              : null;
        const diagWarn = !selectedChild.inHubStatus
          ? `<strong>${esc(selectedChild.label)}</strong> has not sent a <span class="mono">JOIN</span> or window packet to <strong>${esc(s.label || "this Hub")}</strong> since the Hub booted. If ${esc(selectedChild.label)} was already powered on when the Hub was flashed or reset, power-cycle ${esc(selectedChild.label)} (or reflash both timers with the latest v0.1.5 build so Spokes auto-reannounce <span class="mono">JOIN</span>).`
          : frames === 0
            ? `<strong>${esc(selectedChild.label)}</strong> joined TDMA Slot ${selectedChild.slot}, but <strong>0 timing window frames</strong> have reached the Hub. Its 5.8 GHz sweep schedule may have drifted out of phase with the Hub's beacon; power-cycle or reflash ${esc(selectedChild.label)} to re-lock.`
            : selectedChild.msAgo !== undefined && selectedChild.msAgo >= 2500
              ? `Last window frame from <strong>${esc(selectedChild.label)}</strong> arrived <strong>${(selectedChild.msAgo / 1000).toFixed(1)}s ago</strong> (${frames} total frames). Check that ${esc(selectedChild.label)} is powered on and running the same firmware (${esc(s.fw)}).`
              : "";
        const isLight = getAppTheme() === "light";
        const barsHtml = freqs
          .map((f, idx) => {
            const band = racebandName(f) || `Ch${idx + 1}`;
            const col = channelColor(idx);
            const onCh = Boolean(this.signalEnabledCh[idx]);
            const val = dbmSource ? dbmSource[idx] : undefined;
            const valid = onCh && val !== undefined && val > -127 && val < 0;
            const widthPct = valid ? pct(val!) : 0;
            const dotGlow = isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 7px ${col}`;
            return `
              <div class="debug-net-inspector-bar-row ${onCh ? "" : "is-muted"}">
                <span class="debug-bar-label mono"><span class="debug-ch-inline" style="${onCh ? `background:${col};box-shadow:${dotGlow}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col}`}"></span><strong>${band}</strong> ${f}</span>
                <div class="debug-bar-track">
                  <span class="debug-bar-fill" style="width:${widthPct.toFixed(1)}%"></span>
                </div>
                <span class="debug-bar-value mono">${!onCh ? "Off" : valid ? `${val!.toFixed(1)} dBm` : "—"}</span>
              </div>`;
          })
          .join("");

        inspectorHtml = `
          <div class="debug-net-spoke-inspector" data-spoke-inspector="${selectedChild.slot}">
            <div class="debug-net-inspector-head">
              <div class="debug-net-inspector-title">
                <span class="status-dot ${selectedChild.online ? "is-up" : "is-warn"}"></span>
                <strong>${esc(selectedChild.label)}</strong>
                <span class="note">· TDMA Slot ${selectedChild.slot} live stream at ${esc(s.label || "Hub")}</span>
              </div>
              <div class="debug-connect-actions">
                <span class="badge ${selectedChild.online ? "badge-good" : "badge-warn"} mono">${rate.toFixed(1)} pkt/s</span>
                <span class="badge mono">${frames} frames rx</span>
                <span class="badge mono">${esc(selectedChild.fp)}</span>
              </div>
            </div>
            ${diagWarn ? `<div class="debug-net-inspector-alert">${diagWarn}</div>` : ""}
            <div class="debug-net-inspector-kpis">
              <div class="debug-net-inspector-kpi">
                <span class="debug-net-inspector-kpi-label">Frames received by Hub</span>
                <strong class="debug-net-inspector-kpi-val mono">${frames} <span class="note">(${rate.toFixed(1)} pkt/s)</span></strong>
              </div>
              <div class="debug-net-inspector-kpi">
                <span class="debug-net-inspector-kpi-label">Last frame at Hub</span>
                <strong class="debug-net-inspector-kpi-val mono">${selectedChild.msAgo !== undefined && frames > 0 ? `${selectedChild.msAgo} ms ago` : "No frames yet"}</strong>
              </div>
              <div class="debug-net-inspector-kpi">
                <span class="debug-net-inspector-kpi-label">Latest sweep seq #</span>
                <strong class="debug-net-inspector-kpi-val mono">${selectedChild.seq !== undefined && frames > 0 ? `#${selectedChild.seq}` : "—"}</strong>
              </div>
              <div class="debug-net-inspector-kpi">
                <span class="debug-net-inspector-kpi-label">Track timer &amp; server rx</span>
                <strong class="debug-net-inspector-kpi-val">${selectedChild.serverGateLabel ? `${esc(selectedChild.serverGateLabel)} <span class="note mono">· ${selectedChild.serverFrames ?? 0} samples</span>` : `<span class="note">Off track</span>`}</strong>
              </div>
            </div>
            <div class="debug-net-inspector-bars-wrap">
              <div class="debug-subbar">
                <span class="debug-chart-title">5.8 GHz channels received from ${esc(selectedChild.label)} (Slot ${selectedChild.slot})</span>
                <span class="note mono">${dbmSource ? (selectedChild.dbm ? "Direct from Hub USB" : "Via Hub USB stream") : "Waiting for Spoke window frames…"}</span>
              </div>
              <div class="debug-net-inspector-bars">${barsHtml}</div>
            </div>
          </div>`;
      }

      this.slot("network").innerHTML = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}"></span>
            <span class="debug-head-note">${topText}</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge badge-good">Parent Hub · Slot 1</span>
            <span class="badge ${activeRxCount > 0 ? "badge-good" : tiedCount > 0 ? "badge-warn" : ""} mono">${activeRxCount}/${tiedCount} Streaming</span>
          </div>
        </div>
        <div class="debug-network-panels is-hub-view">
          <div class="debug-subbox debug-net-self-card">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title is-active">${icons.wifi(14)}<span>Current device · Hub (Parent)</span></span>
              <span class="badge badge-good">Slot 1 · USB</span>
            </div>
            <div class="debug-net-node-banner is-hub">
              <div class="debug-net-node-main">
                <span class="debug-net-role-tag is-hub">HUB · PARENT</span>
                <strong class="debug-net-node-name">${esc(s.label || "H1")}</strong>
              </div>
              <span class="badge mono">${esc(s.fp)}</span>
            </div>
            <dl class="debug-kv-list">
              <div class="debug-kv-row">
                <dt>TDMA slot</dt>
                <dd>Slot 1 <span class="note">· Beacon master &amp; USB bridge</span></dd>
              </div>
              <div class="debug-kv-row">
                <dt>2.4 GHz link</dt>
                <dd>ESP-NOW LR (500 kbps) <span class="note">· Ch ${ch}</span></dd>
              </div>
              <div class="debug-kv-row">
                <dt>Child Spokes tied</dt>
                <dd>${tiedCount > 0 ? `${tiedCount} Spoke${tiedCount === 1 ? "" : "s"} (${[...bySlot.values()].map((c) => esc(c.label)).join(", ")})` : "None yet (listening for JOIN frames)"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>MAC address</dt>
                <dd><span class="mono">${esc(s.chip?.mac || "—")}</span></dd>
              </div>
            </dl>
          </div>
          <div class="debug-subbox debug-net-peers-card">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title is-active">${icons.slaprf(14)}<span>Child Spokes tied to ${esc(s.label || "this Hub")} (TDMA Slots 2–7)</span></span>
              <span class="note">${tiedCount > 0 ? "Click a Spoke to inspect live data · " : ""}<span class="badge ${activeRxCount > 0 ? "badge-good" : ""}">${tiedCount} of 6 slots</span></span>
            </div>
            <div class="debug-net-slot-grid">${slotCards}</div>
            ${inspectorHtml}
          </div>
        </div>`;
      return;
    }

    // Connected device is a Spoke (Child, Role 2): show Current Spoke + Link Bridge + Parent Hub (Slot 1).
    const selfKnown = knownTimers.find((k) => k.fp.toUpperCase() === s.fp.toUpperCase());
    const serverHub = realServerTimers.find((t) => t.isHub);
    const knownHub =
      (s.hub?.fp ? knownTimers.find((k) => k.fp.toUpperCase() === s.hub!.fp!.toUpperCase()) : undefined) ??
      (selfKnown?.parentHubFp ? knownTimers.find((k) => k.fp.toUpperCase() === selfKnown.parentHubFp!.toUpperCase()) : undefined) ??
      (serverHub?.fingerprint ? knownTimers.find((k) => k.fp.toUpperCase() === serverHub.fingerprint!.toUpperCase()) : undefined) ??
      knownTimers.find((k) => k.role === "hub");

    const beaconMsAgo = s.beaconMsAgo ?? s.hub?.beaconMsAgo;
    const hasSlot = !s.emergencyMode && s.slot >= 2;
    const beaconFresh = beaconMsAgo === undefined || beaconMsAgo < 2500;
    const linked = hasSlot && beaconFresh;
    const beaconStale = hasSlot && !beaconFresh;
    const parentLabel = s.hub?.label || serverHub?.timerLabel || knownHub?.label || "H1";
    const parentFp = s.hub?.fp || serverHub?.fingerprint || knownHub?.fp || "";
    const parentMac = s.hub?.mac || knownHub?.mac || "";
    const parentFw = s.hub?.fw || serverHub?.firmwareVersion || knownHub?.fw || s.fw;

    const spokeIdx = s.slot >= 2 ? s.slot - 2 : 0;
    const tdmaGap = Math.floor(spokeIdx / 3);
    const tdmaOffsetUs = 300 + (spokeIdx % 3) * 3500;

    const ledClass = s.emergencyMode ? "is-emergency" : linked ? "is-up" : "is-warn";
    const topText = s.emergencyMode
      ? `${esc(s.label || "T1")} · Spoke (Child) · Emergency mode active (2.4 GHz link paused)`
      : linked
        ? `${esc(s.label || "T1")} · Spoke (Child · TDMA Slot ${s.slot}) · Tied to Parent Hub ${esc(parentLabel)} (Slot 1) on 2.4 GHz Ch ${ch}${beaconMsAgo !== undefined ? ` · beacon ${beaconMsAgo} ms ago` : ""}`
        : beaconStale
          ? `${esc(s.label || "T1")} · Spoke (Slot ${s.slot}) · Hub sync beacon lost (${((beaconMsAgo ?? 0) / 1000).toFixed(1)}s ago) · out of phase or Hub offline`
          : `${esc(s.label || "T1")} · Spoke (Child) · Searching for Parent Hub sync beacon on 2.4 GHz…`;

    this.slot("network").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="debug-head-note">${topText}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge ${linked ? "badge-good" : "badge-warn"}">${linked ? `Child Spoke · Slot ${s.slot}` : beaconStale ? `Beacon Lost · Slot ${s.slot}` : "Searching for Hub"}</span>
          <span class="badge mono">Parent: ${esc(parentLabel)} (Slot 1)</span>
        </div>
      </div>
      <div class="debug-network-panels is-spoke-view">
        <div class="debug-subbox debug-net-self-card">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title is-active">${icons.cpu(14)}<span>Current device · Spoke (Child)</span></span>
            <span class="badge badge-good">${s.slot >= 2 ? `Slot ${s.slot} · USB` : "USB connected"}</span>
          </div>
          <div class="debug-net-node-banner is-spoke">
            <div class="debug-net-node-main">
              <span class="debug-net-role-tag is-spoke">SPOKE · CHILD</span>
              <strong class="debug-net-node-name">${esc(s.label || "T1")}</strong>
            </div>
            <span class="badge mono">${esc(s.fp)}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Assigned TDMA slot</dt>
              <dd>${hasSlot ? `Slot ${s.slot} of 7 <span class="note">· gap ${tdmaGap}, +${(tdmaOffsetUs / 1000).toFixed(1)} ms</span>` : "Unassigned (sending JOIN)"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Last Hub beacon</dt>
              <dd>${beaconMsAgo !== undefined ? `<span class="mono">${beaconMsAgo} ms ago</span> ${beaconFresh ? `<span class="badge badge-good">Locked</span>` : `<span class="badge badge-warn">Stale (&gt;2.5s)</span>`}` : hasSlot ? "Waiting for beacon…" : "Not heard yet"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>2.4 GHz link</dt>
              <dd>${linked ? `Synced · ESP-NOW LR Ch ${ch}` : beaconStale ? `De-synced on Ch ${ch} (no recent Hub beacon)` : "Scanning 2.4 GHz for Hub beacon"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware</dt>
              <dd><span class="mono">${esc(s.fw)}</span></dd>
            </div>
            <div class="debug-kv-row">
              <dt>MAC address</dt>
              <dd><span class="mono">${esc(s.chip?.mac || "—")}</span></dd>
            </div>
          </dl>
        </div>

        <div class="debug-net-bridge ${linked ? "is-linked" : "is-searching"}">
          <span class="badge ${linked ? "badge-good" : "badge-warn"}">ESP-NOW LR · 2.4 GHz Ch ${ch}</span>
          <div class="debug-net-bridge-track">
            <span class="debug-net-bridge-end mono">${esc(s.label || "T1")} (${hasSlot ? `Slot ${s.slot}` : "Child"})</span>
            <span class="debug-net-bridge-line"></span>
            <span class="debug-net-bridge-arrow">${icons.arrowRight(14)}</span>
            <span class="debug-net-bridge-end mono">${esc(parentLabel)} (Slot 1)</span>
          </div>
          <span class="note">${linked ? `Beacon synced (${beaconMsAgo ?? 0} ms ago) · 4-sweep windows → ${esc(parentLabel)}` : beaconStale ? `Beacon lost (${((beaconMsAgo ?? 0) / 1000).toFixed(1)}s ago) · power-cycle or reflash Spoke` : "Waiting for Hub beacon & ASSIGN frame…"}</span>
        </div>

        <div class="debug-subbox debug-net-parent-card">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${linked ? "is-active" : ""}">${icons.wifi(14)}<span>Parent device · Hub</span></span>
            <span class="badge ${linked ? "badge-good" : "badge-warn"}">${linked ? `Tied · Slot 1` : "Slot 1 · Waiting"}</span>
          </div>
          <div class="debug-net-node-banner is-hub">
            <div class="debug-net-node-main">
              <span class="debug-net-role-tag is-hub">HUB · PARENT</span>
              <strong class="debug-net-node-name">${esc(parentLabel)}</strong>
            </div>
            <span class="badge mono">${parentFp ? esc(parentFp) : "Slot 1"}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Parent Hub</dt>
              <dd><strong>${esc(parentLabel)}</strong> <span class="note">· Hub · TDMA Slot 1</span></dd>
            </div>
            <div class="debug-kv-row">
              <dt>Hub identity</dt>
              <dd>${parentFp ? `<span class="mono">${esc(parentFp)}</span>${parentMac ? ` <span class="note mono">· ${esc(parentMac)}</span>` : ""}` : hasSlot ? `Assigned Slot ${s.slot} over 2.4 GHz` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Link &amp; beacon</dt>
              <dd>${linked ? `Active · 2.4 GHz Ch ${ch} sync beacon locked` : beaconStale ? `Beacon lost (${((beaconMsAgo ?? 0) / 1000).toFixed(1)}s ago)` : "Waiting for Hub beacon"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware</dt>
              <dd><span class="mono">${esc(parentFw)}</span></dd>
            </div>
          </dl>
        </div>
      </div>`;
  }

  private renderLiveHead(): void {
    const liveHeadSlot = this.el.querySelector<HTMLElement>('[data-slot="live-head"]');
    if (!liveHeadSlot) return;
    if (this.isRotorHazardMode()) {
      const isUSB = this.isRotorHazardUSBMode();
      const snap = this.activeRhSnapshot();
      const on = Boolean(snap?.connected);
      const inScanMode = isUSB && this.scanLive;
      const streamDisabled = !on;
      const streamActive = on && !inScanMode && this.rhLiveOn;
      const streamLabel = streamActive ? "Pause" : "Stream";
      const streamTitle = !on
        ? "Connect a RotorHazard timer to stream live node RSSI"
        : streamActive
          ? "Streaming live node RSSI · click to pause"
          : inScanMode
            ? "Paused while Spectrum scan is streaming · click to pause Spectrum scan and stream node RSSI"
            : "Paused · click to stream live node RSSI";
      const ledClass = streamActive ? "is-up" : on && inScanMode ? "is-warn" : "";
      const linkStreamDesc = isUSB ? "~10 Hz USB serial poll" : "~10 Hz Socket.IO heartbeat";
      this.slot("live-head").innerHTML = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}" data-live-led></span>
            <span class="debug-head-note" data-live-note>${streamActive ? `Streaming · ${linkStreamDesc}` : inScanMode ? "Paused · Spectrum scan is streaming" : on ? "Paused · click Stream to monitor node RSSI" : "Offline · click Connect timer above"}</span>
          </span>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm ${streamActive ? "btn-armed" : "btn-unarmed"}" data-action="live" ${streamDisabled ? "disabled" : ""} title="${streamTitle}">
              ${streamActive ? icons.pause(14) : icons.play(14)}<span>${streamLabel}</span>
            </button>
          </div>
        </div>`;
      this.updateLive();
      return;
    }
    if (this.isLapRFMode()) {
      this.slot("live-head").innerHTML = "";
      return;
    }
    const on = this.console.connected;
    const emg = Boolean(on && this.status?.emergencyMode);
    const inScanMode = Boolean(this.scanLive || this.status?.scanLive);
    const streamDisabled = !on || emg;
    const streamActive = !streamDisabled && !inScanMode && this.liveOn;
    const streamLabel = streamActive ? "Pause" : "Stream";
    const streamTitle = emg
      ? "Unavailable while the timer is in Emergency Mode"
      : !on
        ? "Connect a timer to stream live 5.8 GHz readings"
        : streamActive
          ? "Streaming live 5.8 GHz readings · click to pause"
          : inScanMode
            ? "Paused while Spectrum scan is streaming · click to pause Spectrum scan and stream 5.8 GHz channels"
            : "Paused · click to stream live 5.8 GHz readings";
    const ledClass = emg
      ? "is-emergency"
      : streamActive
        ? this.status?.role === 2
          ? "is-spoke"
          : "is-up"
        : on && inScanMode
          ? "is-warn"
          : "";
    this.slot("live-head").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}" data-live-led></span>
          <span class="debug-head-note" data-live-note>${emg ? "Emergency mode · 5.8 GHz receiver & sweeps halted" : on ? "Waiting for sweep stream…" : "Paused · click Connect in the top bar"}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm ${streamActive ? "btn-armed" : "btn-unarmed"}" data-action="live" ${streamDisabled ? "disabled" : ""} title="${streamTitle}">
            ${streamActive ? icons.pause(14) : icons.play(14)}<span>${streamLabel}</span>
          </button>
        </div>
      </div>`;
    this.updateLive();
  }

  /** Build the bar rows once per channel set; updateLive() then only touches styles and text. */
  private renderLive(): void {
    const liveSlot = this.el.querySelector<HTMLElement>('[data-slot="live"]');
    if (!liveSlot) return;
    if (this.isRotorHazardMode()) {
      const snap = this.activeRhSnapshot();
      const on = Boolean(snap?.connected);
      const nCount = snap?.nodeCount === 4 ? 4 : 8;
      const activeCount = Array.from(
        { length: nCount },
        (_, idx) => Boolean(this.signalEnabledCh[idx]) && (snap?.nodeFreqsMhz[idx] ?? 0) > 0
      ).filter(Boolean).length;
      const rowsHtml: string[] = [];
      const isLight = getAppTheme() === "light";
      for (let i = 0; i < nCount; i++) {
        const f = snap?.nodeFreqsMhz[i] ?? 0;
        const band = f > 0 ? hardwareBandLabel(f) : "";
        const freqLabel = f > 0 ? `${band ? `${band} ` : ""}${f}` : "";
        const col = channelColor(i);
        const onCh = this.signalEnabledCh[i];
        const nodeLit = on && onCh && f > 0;
        const dotGlow = isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 7px ${col}`;
        rowsHtml.push(`
          <div class="debug-bar-row ${onCh && f > 0 ? "" : "is-muted"}" data-bar data-action="signal-ch" data-ch="${i}" role="button" tabindex="0" aria-pressed="${onCh}" title="Click to toggle Node ${i + 1}${f > 0 ? ` (${f} MHz)` : ""} monitoring on/off · double-click to solo">
            <span class="debug-bar-label mono"><span class="debug-ch-inline" data-bar-dot style="${nodeLit ? `background:${col};box-shadow:${dotGlow}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col}`}"></span><strong>N${i + 1}</strong> <span data-bar-freq>${esc(freqLabel)}</span></span>
            <div class="debug-bar-track">
              <span class="debug-bar-fill" style="width:0%"></span>
              <span class="debug-bar-peak" style="left:0%;display:none"></span>
            </div>
            <span class="debug-bar-value mono">${!onCh ? "Off" : "— / 255"}</span>
            <span class="debug-bar-hits mono" title="Hardware EnterAt / ExitAt RSSI thresholds and live gate crossing state">—</span>
          </div>`);
      }
      this.slot("live").innerHTML = `
        <div class="debug-subbar">
          <span class="debug-chart-title">Node RSSI meter (${nCount} RX5808 receiver nodes)</span>
          <span class="note debug-live-ch-hint" data-live-ch-note><span class="mono">${activeCount}/${nCount}</span> active · click row to toggle · double-click to solo</span>
        </div>
        <div class="debug-bars">
          ${rowsHtml.join("")}
        </div>
        <div class="debug-scale mono"><span>0 RSSI</span><span>255 RSSI</span></div>`;
      this.updateLive();
      return;
    }
    if (this.isLapRFMode()) {
      this.slot("live").innerHTML = `<p class="note">Slot telemetry for LapRF 8-Way pucks is displayed on the <a href="#/network">Network</a> page.</p>`;
      return;
    }
    const freqs = this.status?.freqs ?? RACEBAND;
    const activeCount = this.signalEnabledCh.filter(Boolean).length;
    const isLight = getAppTheme() === "light";
    this.slot("live").innerHTML = `
      <div class="debug-subbar">
        <span class="debug-chart-title">Channel RSSI meter (8 pilot slots)</span>
        <span class="note debug-live-ch-hint" data-live-ch-note><span class="mono">${activeCount}/8</span> active · click row to toggle · double-click to solo</span>
      </div>
      <div class="debug-bars">
        ${freqs
          .map((f, i) => {
            const band = racebandName(f) || `Ch${i + 1}`;
            const col = channelColor(i);
            const onCh = this.signalEnabledCh[i];
            const dotGlow = isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 7px ${col}`;
            return `
            <div class="debug-bar-row ${onCh ? "" : "is-muted"}" data-bar data-action="signal-ch" data-ch="${i}" role="button" tabindex="0" aria-pressed="${onCh}" title="Click to toggle ${band} (${f} MHz) monitoring on/off · double-click to solo">
              <span class="debug-bar-label mono"><span class="debug-ch-inline" data-bar-dot style="${onCh ? `background:${col};box-shadow:${dotGlow}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col}`}"></span><strong>${band}</strong> ${f}</span>
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
    if (this.isRotorHazardMode()) {
      const snap = this.activeRhSnapshot();
      const on = Boolean(snap?.connected);
      const nCount = snap?.nodeCount === 4 ? 4 : 8;
      const note = this.el.querySelector<HTMLElement>("[data-live-note]");
      const led = this.el.querySelector<HTMLElement>("[data-live-led]");
      const chNote = this.el.querySelector<HTMLElement>("[data-live-ch-note]");
      const activeCount = Array.from(
        { length: nCount },
        (_, idx) => Boolean(this.signalEnabledCh[idx]) && (snap?.nodeFreqsMhz[idx] ?? 0) > 0
      ).filter(Boolean).length;
      if (chNote) {
        chNote.innerHTML = `<span class="mono">${activeCount}/${nCount}</span> active · click row to toggle · double-click to solo`;
      }
      if (led) {
        const inScanMode = this.isRotorHazardUSBMode() && this.scanLive;
        const streaming = on && !inScanMode && this.rhLiveOn;
        led.classList.remove("is-emergency", "is-spoke");
        led.classList.toggle("is-warn", on && inScanMode);
        led.classList.toggle("is-up", streaming);
      }
      if (note) {
        const isUSB = this.isRotorHazardUSBMode();
        if (!on) {
          note.textContent = "Offline · click Connect timer above";
        } else if (isUSB && this.scanLive) {
          note.textContent = "Paused · Spectrum scan is streaming";
        } else if (!this.rhLiveOn) {
          note.textContent = "Paused · click Stream to monitor node RSSI";
        } else if (this.live) {
          note.textContent = `Streaming · ~${this.activeSweepHz()} Hz ${isUSB ? "USB serial poll" : "Socket.IO heartbeat"} · ${snap?.heartbeatsRx ?? 0} frames`;
        } else {
          note.textContent = isUSB ? "Streaming · waiting for USB poll…" : "Streaming · waiting for heartbeat…";
        }
      }
      const now = performance.now();
      const pct = (x: number) => Math.max(0, Math.min(100, (x / 255) * 100));
      const isLight = getAppTheme() === "light";
      this.el.querySelectorAll<HTMLElement>("[data-bar]").forEach((row, i) => {
        const onCh = Boolean(this.signalEnabledCh[i]);
        const col = channelColor(i);
        const f = snap?.nodeFreqsMhz[i] ?? 0;
        const nodeLit = on && onCh && f > 0;
        row.classList.toggle("is-muted", !onCh || f <= 0);
        row.setAttribute("aria-pressed", String(onCh));
        const dot = row.querySelector<HTMLElement>("[data-bar-dot]");
        if (dot) {
          dot.style.background = nodeLit ? col : "transparent";
          dot.style.boxShadow = nodeLit ? (isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 7px ${col}`) : `inset 0 0 0 1.5px ${col}`;
        }
        const freqSpan = row.querySelector<HTMLElement>("[data-bar-freq]");
        if (freqSpan) {
          const band = f > 0 ? hardwareBandLabel(f) : "";
          const nextFreqLabel = f > 0 ? `${band ? `${band} ` : ""}${f}` : "";
          if (freqSpan.textContent !== nextFreqLabel) freqSpan.textContent = nextFreqLabel;
        }
        const fill = row.querySelector<HTMLElement>(".debug-bar-fill")!;
        const peak = row.querySelector<HTMLElement>(".debug-bar-peak")!;
        const value = row.querySelector<HTMLElement>(".debug-bar-value")!;
        const hits = row.querySelector<HTMLElement>(".debug-bar-hits")!;
        const enterAt = snap?.nodeEnterLevels[i] ?? 90;
        const exitAt = snap?.nodeExitLevels[i] ?? 70;
        const crossing = Boolean(snap?.crossingFlag[i]);

        if (!on || !onCh || f <= 0) {
          this.barFillVal[i] = -128;
          this.barFillAt[i] = 0;
          this.barPeakVal[i] = -128;
          this.barPeakAt[i] = 0;
          fill.style.width = "0%";
          peak.style.display = "none";
          value.textContent = !onCh ? "Off" : "— / 255";
          hits.textContent = f > 0 ? `E:${enterAt}/X:${exitAt}` : "—";
          hits.classList.remove("is-active");
          return;
        }

        const rawRssi = this.rhLiveOn && this.live ? (this.live.dbm[i] ?? -128) : (snap?.slotRssi[i] ?? 0);
        const sampleRssi = rawRssi > -127 ? Math.max(0, Math.min(255, Math.round(rawRssi))) : 0;
        const rising = sampleRssi >= this.barFillVal[i];
        if (this.barFillVal[i] <= -127 || rising || now - this.barFillAt[i] >= 160) {
          this.barFillVal[i] = sampleRssi;
          if (rising || this.barFillAt[i] === 0) {
            this.barFillAt[i] = now;
          }
        }
        if (this.barPeakVal[i] <= -127 || sampleRssi >= this.barPeakVal[i] || now - this.barPeakAt[i] >= 1500) {
          this.barPeakVal[i] = sampleRssi;
          this.barPeakAt[i] = now;
        }
        const shownFill = Math.max(0, this.barFillVal[i]);
        const heldPk = Math.max(0, this.barPeakVal[i]);
        fill.style.width = `${pct(shownFill)}%`;
        peak.style.display = "";
        peak.style.left = `${pct(heldPk)}%`;
        value.textContent = `${shownFill} / 255`;
        const isTrig = crossing || shownFill >= enterAt;
        hits.textContent = isTrig ? "CROSSING" : `E:${enterAt}/X:${exitAt}`;
        hits.classList.remove("is-active");
      });
      return;
    }
    if (this.isLapRFMode()) return;

    const l = this.live;
    const note = this.el.querySelector<HTMLElement>("[data-live-note]");
    const led = this.el.querySelector<HTMLElement>("[data-live-led]");
    const chNote = this.el.querySelector<HTMLElement>("[data-live-ch-note]");
    const on = this.console.connected;
    const emg = Boolean(on && this.status?.emergencyMode);
    const rfOn = this.status?.rf.enabled ?? true;
    const inScanMode = Boolean(this.scanLive || this.status?.scanLive);
    const activeCount = this.signalEnabledCh.filter(Boolean).length;
    if (chNote) {
      chNote.innerHTML = `<span class="mono">${activeCount}/8</span> active · click row to toggle · double-click to solo`;
    }
    if (led) {
      const streaming = !emg && on && rfOn && !inScanMode && this.liveOn;
      led.classList.toggle("is-emergency", emg);
      led.classList.toggle("is-up", streaming && this.status?.role !== 2);
      led.classList.toggle("is-spoke", streaming && this.status?.role === 2);
      led.classList.toggle("is-warn", !emg && on && inScanMode);
    }
    if (note) {
      if (!on) {
        note.textContent = "Paused · click Connect in the top bar";
      } else if (emg) {
        note.textContent = "Emergency mode · 5.8 GHz receiver & sweeps halted";
      } else if (inScanMode) {
        note.textContent = "Paused · Spectrum scan is streaming";
      } else if (!this.liveOn) {
        note.textContent = "Paused · click Stream to view live 5.8 GHz readings";
      } else if (l) {
        const hz = this.status?.sweepHz ?? 100;
        note.textContent = `Streaming · ${this.liveMode === 2 ? `${hz} Hz (every sweep)` : "10 Hz"} · sweep ${(l.us / 1000).toFixed(2)} ms`;
      } else {
        note.textContent = "Streaming · waiting for sweeps…";
      }
    }
    const now = performance.now();
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    const isLight = getAppTheme() === "light";
    this.el.querySelectorAll<HTMLElement>("[data-bar]").forEach((row, i) => {
      const onCh = Boolean(this.signalEnabledCh[i]);
      const col = channelColor(i);
      row.classList.toggle("is-muted", !onCh);
      row.setAttribute("aria-pressed", String(onCh));
      const dot = row.querySelector<HTMLElement>("[data-bar-dot]");
      if (dot) {
        dot.style.background = onCh ? col : "transparent";
        dot.style.boxShadow = onCh ? (isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 7px ${col}`) : `inset 0 0 0 1.5px ${col}`;
      }
      const fill = row.querySelector<HTMLElement>(".debug-bar-fill")!;
      const peak = row.querySelector<HTMLElement>(".debug-bar-peak")!;
      const value = row.querySelector<HTMLElement>(".debug-bar-value")!;
      const hits = row.querySelector<HTMLElement>(".debug-bar-hits")!;
      const v = onCh ? l?.dbm[i] : undefined;
      const sampleDbm = onCh ? Math.max(v ?? -127, l?.pk[i] ?? -127) : -127;
      if (!onCh || sampleDbm <= -127) {
        this.barFillVal[i] = -127;
        this.barFillAt[i] = 0;
        this.barPeakVal[i] = -127;
        this.barPeakAt[i] = 0;
      } else {
        // Green fill bar: instant attack to the spike (including pk), hold 160 ms so brief spikes are clearly visible
        const rising = sampleDbm >= this.barFillVal[i];
        if (rising || now - this.barFillAt[i] >= 160) {
          this.barFillVal[i] = sampleDbm;
          if (rising) {
            this.barFillAt[i] = now;
          }
        }
        // White peak tick: instant attack, hold steady for 1.5 s, then snap directly back to current reading (no crawl)
        if (sampleDbm >= this.barPeakVal[i] || now - this.barPeakAt[i] >= 1500) {
          this.barPeakVal[i] = sampleDbm;
          this.barPeakAt[i] = now;
        }
      }
      const shownFill = this.barFillVal[i];
      const heldPk = this.barPeakVal[i];
      const h = onCh ? l?.hits?.[i] : undefined;
      fill.style.width = shownFill > -127 ? `${pct(shownFill)}%` : "0%";
      peak.style.display = heldPk > -127 ? "" : "none";
      if (heldPk > -127) peak.style.left = `${pct(heldPk)}%`;
      value.textContent = !onCh ? "Off" : shownFill > -127 ? `${shownFill} dBm` : "—";
      hits.textContent = !onCh ? "—" : h !== undefined ? `${h} hit${h === 1 ? "" : "s"}` : "—";
      hits.classList.toggle("is-active", onCh && (h ?? 0) > 0);
    });
  }

  private renderChannels(): void {
    // Channel overrides are managed via the Serial console (CHANNELS <f1,...,f8> / CHANNELS RESET).
  }

  private syncChannelInputsState(): void {
    const on = this.console.connected;
    const s = this.status;
    const emg = Boolean(on && s?.emergencyMode);
    const inScanMode = Boolean(this.scanLive || s?.scanLive);
    const canEdit = Boolean(on && s && !inScanMode && !emg);
    const activeFreqs = s?.freqs ?? RACEBAND;
    const isTemp = Boolean(s?.freqsTemporary);
    const inputs = [...this.el.querySelectorAll<HTMLInputElement>("[data-chan]")];
    const curVals = inputs.map((inp, i) => {
      const v = Math.round(Number(inp.value));
      const tagEl = this.el.querySelector<HTMLElement>(`[data-chan-tag="${i}"]`);
      if (tagEl) {
        tagEl.textContent = racebandName(v) || `Ch ${i + 1}`;
      }
      return v;
    });
    const dirty = curVals.some((v, i) => v !== (activeFreqs[i] ?? RACEBAND[i]));
    const isRb = curVals.length === 8 && curVals.every((v, i) => v === RACEBAND[i]);
    this.channelsDirty = dirty;

    const noteEl = this.el.querySelector<HTMLElement>("[data-channels-note]");
    if (noteEl) {
      noteEl.textContent = dirty ? "· unsaved edits" : isTemp ? "· temporary override" : "· saved in NVS";
    }
    const rbBtn = this.el.querySelector<HTMLButtonElement>("[data-channels-rb-btn]");
    if (rbBtn) {
      rbBtn.disabled = !canEdit || isRb;
    }
    const resetBtn = this.el.querySelector<HTMLButtonElement>("[data-channels-reset-btn]");
    if (resetBtn) {
      resetBtn.disabled = !canEdit || (!isTemp && !dirty);
    }
    const applyBtn = this.el.querySelector<HTMLButtonElement>("[data-channels-apply-btn]");
    if (applyBtn) {
      applyBtn.disabled = !canEdit || !dirty;
      applyBtn.classList.toggle("btn-armed", dirty || isTemp);
      applyBtn.classList.toggle("btn-unarmed", !dirty && !isTemp);
    }
    const applyLbl = this.el.querySelector<HTMLElement>("[data-channels-apply-label]");
    if (applyLbl) {
      applyLbl.textContent = isTemp && !dirty ? "Applied" : "Apply";
    }
  }

  private renderSignalControls(): void {
    const presets = [1, 2, 5, 10, 15, 30, 120] as const;
    const xWinLabel =
      this.signalWindowSec === 120
        ? "2 min"
        : this.signalWindowSec < 10 && Math.abs(this.signalWindowSec - Math.round(this.signalWindowSec)) >= 0.05
          ? `${this.signalWindowSec.toFixed(1)} s`
          : `${Math.round(this.signalWindowSec)} s`;
    const xWinShort =
      this.signalWindowSec === 120
        ? "2m"
        : this.signalWindowSec < 10 && Math.abs(this.signalWindowSec - Math.round(this.signalWindowSec)) >= 0.05
          ? `${this.signalWindowSec.toFixed(1)}s`
          : `${Math.round(this.signalWindowSec)}s`;

    if (this.isRotorHazardMode()) {
      const isUSB = this.isRotorHazardUSBMode();
      const snap = this.activeRhSnapshot();
      const on = Boolean(snap?.connected);
      const inScanMode = isUSB && this.scanLive;
      const streamRunning = on && !inScanMode && this.rhLiveOn;
      const nCount = snap?.nodeCount === 4 ? 4 : 8;
      const hasPts = this.signalRing.points.length > 0;
      const allOn = this.signalEnabledCh.slice(0, nCount).every(Boolean);
      const isLive = this.signalEndN === null;
      const liveFollowOn = isLive && streamRunning;
      const liveDisabled = !on && !hasPts;
      const isYZoomed = Math.round(this.signalYMin) !== 0 || Math.round(this.signalYMax) !== 255;
      const isFloorY = !this.signalAutoY && Math.round(this.signalYMin) === 0 && Math.round(this.signalYMax) === 130;
      const ySigShort = isFloorY ? "Base" : !isYZoomed ? "Full" : `${Math.round(this.signalYMax - this.signalYMin)}`;
      const liveLabel = liveFollowOn ? "Pause" : "Stream";
      const linkDesc = isUSB ? "USB serial polls" : "Socket.IO heartbeats";
      const linkSing = isUSB ? "USB serial poll" : "Socket.IO heartbeat";
      const liveTitle = !on
        ? "Connect a RotorHazard timer to stream node RSSI"
        : liveFollowOn
          ? `Streaming ~10 Hz ${linkDesc} · click to pause, or drag the chart to scroll back`
          : inScanMode
            ? "Paused while Spectrum scan is streaming · click to pause Spectrum scan and stream node RSSI"
            : "Paused · click to stream live node RSSI";
      const sigLedClass = liveFollowOn ? "is-up" : (streamRunning && !isLive) || (on && inScanMode) ? "is-warn" : "";
      const sigStatusText = liveFollowOn
        ? `Streaming · ~10 Hz ${linkSing} · ${snap?.heartbeatsRx ?? 0} frames`
        : streamRunning && !isLive
          ? "Paused · scrolled back"
          : inScanMode
            ? "Paused · scan active"
            : on
              ? "Paused · click Stream to record node RSSI"
              : "Offline · click Connect timer above";

      const legendButtons: string[] = [];
      for (let i = 0; i < nCount; i++) {
        const f = snap?.nodeFreqsMhz[i] ?? 0;
        const band = f > 0 ? hardwareBandLabel(f) : "";
        const lbl = f > 0 ? `${band ? `${band} ` : ""}${f}` : "";
        const chOn = this.signalEnabledCh[i];
        const nodeLit = on && chOn && f > 0;
        const col = channelColor(i);
        legendButtons.push(
          `<button type="button" class="chart-legend-item mono ${nodeLit ? "" : "is-hidden"}" data-action="signal-ch" data-ch="${i}" aria-pressed="${chOn}" title="${chOn ? `Click to hide Node ${i + 1}${lbl ? ` (${lbl})` : ""} · double-click to solo` : `Click to show Node ${i + 1}${lbl ? ` (${lbl})` : ""} · double-click to solo`}">
            <i style="--c:${col}"></i>
            <span><strong>N${i + 1}</strong>${lbl ? ` ${esc(lbl)}` : ""}</span>
          </button>`
        );
      }

      this.slot("signal-head").innerHTML = `
        <div class="debug-status-topbar">
          <span class="debug-led-status" title="${liveTitle}">
            <span class="status-dot ${sigLedClass}"></span>
            <span class="debug-head-note" data-signal-head-note>${sigStatusText}</span>
          </span>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-action="signal-clear" data-signal-clear-btn ${hasPts ? "" : "disabled"}>Clear</button>
            <button type="button" class="btn btn-sm ${liveFollowOn ? "btn-armed" : "btn-unarmed"}" data-action="signal-freeze" ${liveDisabled ? "disabled" : ""} title="${liveTitle}">
              ${liveFollowOn ? icons.pause(14) : icons.play(14)}<span>${liveLabel}</span>
            </button>
          </div>
        </div>`;
      this.slot("signal-controls").innerHTML = `
        <div class="debug-subbar">
          <span class="debug-chart-title">Signal over time (0–255 RSSI × time)</span>
          <div class="debug-connect-actions">
            <div class="debug-overlay-checks" role="group" aria-label="Chart overlays">
              <label class="check" title="Show per-node baseline noise floor (dotted)">
                <input type="checkbox" data-check="signal-floor" ${this.signalShowFloor ? "checked" : ""}/>
                <span>Baseline floor</span>
              </label>
              <label class="check" title="Show hardware EnterAt / ExitAt RSSI thresholds">
                <input type="checkbox" data-check="signal-thr" ${this.signalShowThresholds ? "checked" : ""}/>
                <span>Enter / Exit thresholds</span>
              </label>
            </div>
          </div>
        </div>`;
      this.slot("signal-legend").innerHTML = `
        <div class="chart-legend debug-signal-legend" role="group" aria-label="Node trace legend">
          ${legendButtons.join("")}
          <button type="button" class="chart-legend-item debug-legend-all" data-action="signal-ch-all" title="${allOn ? `Hide all ${nCount} node traces` : `Show all ${nCount} node traces`}">
            <span>${allOn ? "Hide all" : "Show all"}</span>
          </button>
        </div>
        <div class="debug-chart-foot">
          <div class="debug-toolbar-left">
            <div class="debug-axis-pill ${this.signalAutoX ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${this.signalAutoX ? "toggle-axis-menu" : "signal-reset-x"}" data-menu="signal-x" title="${this.signalAutoX ? `Auto X-axis time window (${xWinLabel}) · click to choose a time window preset` : "Click to reset X-axis time window to Auto X"}">
                ${icons.target(13)}<span>${this.signalAutoX ? "Auto X" : `<span class="debug-hint-desktop">X: ${xWinLabel}</span><span class="debug-hint-mobile">X: ${xWinShort}</span>`}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="signal-x" aria-expanded="${this.openAxisMenu === "signal-x"}" title="Choose X-axis time window">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "signal-x"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="X-axis time window">
                      <button type="button" class="debug-axis-menu-item ${this.signalAutoX ? "is-active" : ""}" data-action="signal-auto-x" data-force="1" role="menuitem">
                        <span>Auto X</span><span class="note">${xWinLabel}</span>
                      </button>
                      <div class="debug-axis-menu-sep"></div>
                      ${presets
                        .map((w) => {
                          const active = !this.signalAutoX && Math.abs(this.signalWindowSec - w) < 0.05;
                          const label = w === 120 ? "2 min" : `${w} s`;
                          return `<button type="button" class="debug-axis-menu-item ${active ? "is-active" : ""}" data-action="signal-window" data-win="${w}" role="menuitem"><span>${label}</span></button>`;
                        })
                        .join("")}
                    </div>`
                  : ""
              }
            </div>
            <div class="debug-axis-pill ${this.signalAutoY ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${this.signalAutoY ? "toggle-axis-menu" : "signal-reset-y"}" data-menu="signal-y" title="${this.signalAutoY ? "Auto Y-axis scaling is ON (fits visible node RSSI traces automatically). Click to choose a scale preset." : "Click to reset Y-axis range to Auto Y"}">
                ${icons.target(13)}<span>${this.signalAutoY ? "Auto Y" : `<span class="debug-hint-desktop">Y: ${Math.round(this.signalYMin)}…${Math.round(this.signalYMax)} RSSI</span><span class="debug-hint-mobile">Y: ${ySigShort}</span>`}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="signal-y" aria-expanded="${this.openAxisMenu === "signal-y"}" title="Choose Y-axis RSSI scale">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "signal-y"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="Y-axis RSSI scale">
                      <button type="button" class="debug-axis-menu-item ${this.signalAutoY ? "is-active" : ""}" data-action="signal-auto-y" data-force="1" role="menuitem">
                        <span>Auto Y</span><span class="note">Fit traces</span>
                      </button>
                      <div class="debug-axis-menu-sep"></div>
                      <button type="button" class="debug-axis-menu-item ${isFloorY ? "is-active" : ""}" data-action="signal-zoom-floor" role="menuitem">
                        <span>Baseline &amp; thresholds</span><span class="note">0…130 RSSI</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${!this.signalAutoY && !isYZoomed ? "is-active" : ""}" data-action="signal-full-y" role="menuitem">
                        <span>Full scale</span><span class="note">0…255 RSSI</span>
                      </button>
                    </div>`
                  : ""
              }
            </div>
          </div>
          <span class="note debug-chart-hint"><span class="debug-hint-desktop">Drag chart to pan · Shift+drag box to zoom · drag axes to stretch</span><span class="debug-hint-mobile">Drag chart to pan · drag axes to stretch · double-tap to reset</span></span>
          <div class="debug-connect-actions">
            <div class="debug-btn-group" role="group" aria-label="Export signal chart">
              <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-csv" ${hasPts ? "" : "disabled"} title="Download recorded node RSSI samples as CSV">CSV</button>
              <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-png" ${hasPts ? "" : "disabled"} title="Save signal chart snapshot as PNG">PNG</button>
            </div>
          </div>
        </div>`;
      return;
    }

    const on = this.console.connected;
    const emg = Boolean(on && this.status?.emergencyMode);
    const inScanMode = Boolean(this.scanLive || this.status?.scanLive);
    const streamRunning = on && !emg && this.liveOn && !inScanMode;
    const freqs = this.status?.freqs ?? RACEBAND;
    const hasPts = this.signalRing.points.length > 0;
    const allOn = this.signalEnabledCh.every(Boolean);
    const isLive = this.signalEndN === null;
    const liveFollowOn = isLive && streamRunning;
    const liveDisabled = (!on || emg) && !hasPts;
    const isYZoomed = this.signalYMin !== DBM_MIN || this.signalYMax !== DBM_MAX;
    const liveLabel = liveFollowOn ? "Pause" : "Stream";
    const liveTitle = emg
      ? "Unavailable while the timer is in Emergency Mode"
      : !on
        ? "Connect a timer to stream live 50 Hz sweeps"
        : liveFollowOn
          ? "Streaming 50 Hz sweeps · click to pause, or drag the chart to scroll back"
          : inScanMode
            ? "Paused while Spectrum scan is streaming · click to pause Spectrum scan and stream 50 Hz sweeps"
            : "Paused · click to stream live 50 Hz sweeps";
    const isFloorY = !this.signalAutoY && Math.round(this.signalYMin) === -102 && Math.round(this.signalYMax) === -68;
    const ySigShort = isFloorY ? "Floor" : !isYZoomed ? "Full" : `${Math.round(this.signalYMax - this.signalYMin)}dB`;
    const sigLedClass = emg
      ? "is-emergency"
      : liveFollowOn
        ? this.status?.role === 2
          ? "is-spoke"
          : "is-up"
        : (streamRunning && !isLive) || (on && inScanMode)
          ? "is-warn"
          : "";
    const sigStatusText = emg
      ? "Emergency mode · sweeps halted"
      : liveFollowOn
        ? `Streaming · ${this.liveMode === 2 ? "50 Hz" : "10 Hz"}${this.live ? ` · sweep ${(this.live.us / 1000).toFixed(2)} ms` : ""}`
        : streamRunning && !isLive
          ? "Paused · scrolled back"
          : inScanMode
            ? "Paused · scan active"
            : on
              ? "Paused · click Stream to record 50 Hz sweeps"
              : "Paused · click Connect in the top bar";
    this.slot("signal-head").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status" title="${liveTitle}">
          <span class="status-dot ${sigLedClass}"></span>
          <span class="debug-head-note">${sigStatusText}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="signal-clear" ${hasPts ? "" : "disabled"}>Clear</button>
          <button type="button" class="btn btn-sm ${liveFollowOn ? "btn-armed" : "btn-unarmed"}" data-action="signal-freeze" ${liveDisabled ? "disabled" : ""} title="${liveTitle}">
            ${liveFollowOn ? icons.pause(14) : icons.play(14)}<span>${liveLabel}</span>
          </button>
        </div>
      </div>`;
    this.slot("signal-controls").innerHTML = `
      <div class="debug-subbar">
        <span class="debug-chart-title">Signal over time (dBm × time)</span>
        <div class="debug-connect-actions">
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
      </div>`;
    this.slot("signal-legend").innerHTML = `
      <div class="chart-legend debug-signal-legend" role="group" aria-label="Channel trace legend">
        ${freqs
          .map((f, i) => {
            const rb = racebandName(f) || `Ch${i + 1}`;
            const chOn = this.signalEnabledCh[i];
            const col = channelColor(i);
            return `<button type="button" class="chart-legend-item mono ${chOn ? "" : "is-hidden"}" data-action="signal-ch" data-ch="${i}" aria-pressed="${chOn}" title="${chOn ? `Click to hide ${rb} (${f} MHz) · double-click to solo` : `Click to show ${rb} (${f} MHz) · double-click to solo`}">
              <i style="--c:${col}"></i>
              <span><strong>${rb}</strong> ${f}</span>
            </button>`;
          })
          .join("")}
        <button type="button" class="chart-legend-item debug-legend-all" data-action="signal-ch-all" title="${allOn ? "Hide all 8 channel traces" : "Show all 8 channel traces"}">
          <span>${allOn ? "Hide all" : "Show all"}</span>
        </button>
      </div>
      <div class="debug-chart-foot">
        <div class="debug-toolbar-left">
          <div class="debug-axis-pill ${this.signalAutoX ? "is-armed" : "is-unarmed"}" data-axis-pill>
            <button type="button" class="debug-axis-pill-main" data-action="${this.signalAutoX ? "toggle-axis-menu" : "signal-reset-x"}" data-menu="signal-x" title="${this.signalAutoX ? `Auto X-axis time window (${xWinLabel}) · click to choose a time window preset` : "Click to reset X-axis time window to Auto X"}">
              ${icons.target(13)}<span>${this.signalAutoX ? "Auto X" : `<span class="debug-hint-desktop">X: ${xWinLabel}</span><span class="debug-hint-mobile">X: ${xWinShort}</span>`}</span>
            </button>
            <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="signal-x" aria-expanded="${this.openAxisMenu === "signal-x"}" title="Choose X-axis time window">
              ${icons.chevronDown(12)}
            </button>
            ${
              this.openAxisMenu === "signal-x"
                ? `<div class="debug-axis-menu" role="menu" aria-label="X-axis time window">
                    <button type="button" class="debug-axis-menu-item ${this.signalAutoX ? "is-active" : ""}" data-action="signal-auto-x" data-force="1" role="menuitem">
                      <span>Auto X</span><span class="note">${xWinLabel}</span>
                    </button>
                    <div class="debug-axis-menu-sep"></div>
                    ${presets
                      .map((w) => {
                        const active = !this.signalAutoX && Math.abs(this.signalWindowSec - w) < 0.05;
                        const label = w === 120 ? "2 min" : `${w} s`;
                        return `<button type="button" class="debug-axis-menu-item ${active ? "is-active" : ""}" data-action="signal-window" data-win="${w}" role="menuitem"><span>${label}</span></button>`;
                      })
                      .join("")}
                  </div>`
                : ""
            }
          </div>
          <div class="debug-axis-pill ${this.signalAutoY ? "is-armed" : "is-unarmed"}" data-axis-pill>
            <button type="button" class="debug-axis-pill-main" data-action="${this.signalAutoY ? "toggle-axis-menu" : "signal-reset-y"}" data-menu="signal-y" title="${this.signalAutoY ? "Auto Y-axis scaling is ON (fits visible signal traces automatically). Click to choose a scale preset, or drag the Y-axis to stretch." : "Click to reset Y-axis range to Auto Y"}">
              ${icons.target(13)}<span>${this.signalAutoY ? "Auto Y" : `<span class="debug-hint-desktop">Y: ${Math.round(this.signalYMin)}…${Math.round(this.signalYMax)} dBm</span><span class="debug-hint-mobile">Y: ${ySigShort}</span>`}</span>
            </button>
            <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="signal-y" aria-expanded="${this.openAxisMenu === "signal-y"}" title="Choose Y-axis dBm scale">
              ${icons.chevronDown(12)}
            </button>
            ${
              this.openAxisMenu === "signal-y"
                ? `<div class="debug-axis-menu" role="menu" aria-label="Y-axis dBm scale">
                    <button type="button" class="debug-axis-menu-item ${this.signalAutoY ? "is-active" : ""}" data-action="signal-auto-y" data-force="1" role="menuitem">
                      <span>Auto Y</span><span class="note">Fit traces</span>
                    </button>
                    <div class="debug-axis-menu-sep"></div>
                    <button type="button" class="debug-axis-menu-item ${isFloorY ? "is-active" : ""}" data-action="signal-zoom-floor" role="menuitem">
                      <span>Noise floor</span><span class="note">−102…−68 dBm</span>
                    </button>
                    <button type="button" class="debug-axis-menu-item ${!this.signalAutoY && !isYZoomed ? "is-active" : ""}" data-action="signal-full-y" role="menuitem">
                      <span>Full scale</span><span class="note">${DBM_MIN}…${DBM_MAX} dBm</span>
                    </button>
                  </div>`
                : ""
            }
          </div>
        </div>
        <span class="note debug-chart-hint"><span class="debug-hint-desktop">Drag chart to pan · Shift+drag box to zoom · drag axes to stretch</span><span class="debug-hint-mobile">Drag chart to pan · drag axes to stretch · double-tap to reset</span></span>
        <div class="debug-connect-actions">
          <div class="debug-btn-group" role="group" aria-label="Export signal chart">
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-csv" ${hasPts ? "" : "disabled"} title="Download recorded 50 Hz samples as CSV">CSV</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-png" ${hasPts ? "" : "disabled"} title="Save signal chart snapshot as PNG">PNG</button>
          </div>
        </div>
      </div>`;
  }

  private recordRhFindingFromSample(snap: RHClientDiagSnapshot, s: LiveSample): void {
    const now = Date.now();
    const nCount = snap.nodeCount === 4 ? 4 : 8;
    for (let i = 0; i < nCount; i++) {
      const f = snap.nodeFreqsMhz[i] ?? 0;
      if (f <= 0) continue;
      const v = s.dbm[i] ?? -128;
      if (v <= -127) continue;
      const col = channelColor(i);
      const enterThr = snap.nodeEnterLevels[i] ?? 90;
      const exitThr = snap.nodeExitLevels[i] ?? 70;
      const floor = s.floor?.[i] !== undefined && s.floor[i] > -127 ? s.floor[i] : v;
      const crossing = Boolean(snap.crossingFlag[i]) || v >= enterThr;
      const sourceLabel = `N${i + 1} · ${formatHardwareFreq(f)}`;

      if (crossing) {
        const key = `rh-trig:${i}`;
        const existing = this.signalFindings.find((e) => e.key === key && now - e.lastMs <= 4000);
        if (existing) {
          existing.lastMs = now;
          existing.maxDbm = Math.max(existing.maxDbm, v);
          existing.count++;
          const durSec = (existing.lastMs - existing.firstMs) / 1000;
          existing.detail = `Peak ${existing.maxDbm} RSSI crossed N${i + 1} EnterAt ${enterThr} (+${existing.maxDbm - enterThr} RSSI; ExitAt ${exitThr}) · ${existing.count} samples${durSec >= 0.2 ? ` over ${durSec.toFixed(1)} s` : ""}`;
        } else {
          this.signalFindings.unshift({
            id: ++this.signalFindingSeq,
            key,
            firstMs: now,
            lastMs: now,
            timeLabel: fmtWallTimeMs(now),
            tone: "badge-warn",
            badge: "Crossing",
            sourceLabel,
            sourceColor: col,
            channelIndex: i,
            freqMHz: f,
            maxDbm: v,
            count: 1,
            detail: `Peak ${v} RSSI crossed N${i + 1} EnterAt ${enterThr} (+${v - enterThr} RSSI; ExitAt ${exitThr})`,
          });
        }
      } else if (v >= floor + 15) {
        const key = `rh-burst:${i}`;
        const existing = this.signalFindings.find((e) => e.key === key && now - e.lastMs <= 4000);
        if (existing) {
          existing.lastMs = now;
          existing.maxDbm = Math.max(existing.maxDbm, v);
          existing.count++;
          const durSec = (existing.lastMs - existing.firstMs) / 1000;
          existing.detail = `Spike to ${existing.maxDbm} RSSI (+${existing.maxDbm - floor} above ${floor} RSSI baseline, ${enterThr - existing.maxDbm} below EnterAt ${enterThr}) · ${existing.count} samples${durSec >= 0.2 ? ` over ${durSec.toFixed(1)} s` : ""}`;
        } else {
          this.signalFindings.unshift({
            id: ++this.signalFindingSeq,
            key,
            firstMs: now,
            lastMs: now,
            timeLabel: fmtWallTimeMs(now),
            tone: "badge-accent",
            badge: "RF spike",
            sourceLabel,
            sourceColor: col,
            channelIndex: i,
            freqMHz: f,
            maxDbm: v,
            count: 1,
            detail: `Spike to ${v} RSSI (+${v - floor} above ${floor} RSSI baseline, ${enterThr - v} below EnterAt ${enterThr}; below crossing threshold)`,
          });
        }
      }
    }

    if (this.signalFindings.length === 0 && this.signalRing.points.length >= 15) {
      const validFloors = (s.floor ?? []).slice(0, nCount).filter((fl) => fl > -127);
      if (validFloors.length > 0) {
        const minFl = Math.min(...validFloors);
        const maxFl = Math.max(...validFloors);
        this.signalFindings.unshift({
          id: ++this.signalFindingSeq,
          key: "rh-baseline",
          firstMs: now,
          lastMs: now,
          timeLabel: fmtWallTimeMs(now),
          tone: "badge-good",
          badge: "Quiet",
          sourceLabel: `${validFloors.length} active nodes`,
          maxDbm: maxFl,
          count: this.signalRing.points.length,
          detail: `Baseline noise steady at ${minFl}…${maxFl} RSSI across active RX5808 nodes.`,
        });
      }
    }

    if (this.signalFindings.length > 100) {
      this.signalFindings.length = 100;
    }
  }

  private recordSignalFindingFromSample(s: LiveSample): void {
    const now = Date.now();
    const freqs = this.status?.freqs ?? RACEBAND;
    for (let i = 0; i < 8; i++) {
      const f = freqs[i] ?? RACEBAND[i];
      const rb = racebandName(f) || `Ch${i + 1}`;
      const col = channelColor(i);
      const pilot = this.pilots.find((p) => Math.abs(p.frequencyMHz - f) <= 2);
      const enterThr = pilot ? pilot.enterThreshold : -65;
      const pilotLabel = pilot?.callsign ? `${pilot.callsign} (${enterThr} dBm)` : `${enterThr} dBm`;
      const floor = s.floor?.[i] !== undefined && s.floor[i] > -127 ? s.floor[i] : -95;
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
            channelIndex: i,
            freqMHz: f,
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
            channelIndex: i,
            freqMHz: f,
            maxDbm: v,
            count: Math.max(1, hits),
            detail: `Burst to ${v} dBm (+${v - floor} dB above ${floor} dBm floor, ${enterThr - v} dB below enter; will not trigger a lap)`,
          });
        }
      }
    }

    if (this.signalFindings.length === 0 && this.signalRing.points.length >= 25) {
      const validFloors = (s.floor ?? []).filter((fl) => fl > -127);
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
    const isRssiScale = this.isRotorHazardUSBMode();
    const unit = isRssiScale ? "RSSI" : "dBm";
    const diffUnit = isRssiScale ? "RSSI" : "dB";
    const minProm = isRssiScale ? 18 : 6;
    const strongThr = isRssiScale ? 120 : -65;
    const peaks = this.spectrumAcc.topPeaks(5, minProm);
    const sorted = [...s.dbm].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : isRssiScale ? 24 : -95;
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
          existing.freqMHz = p.freqMHz;
          existing.tone = existing.maxDbm >= strongThr ? "badge-warn" : "badge-accent";
          existing.badge = existing.maxDbm >= strongThr ? "Strong peak" : "RF peak";
          existing.sourceLabel = `${p.freqMHz} MHz · ${p.bandHint}`;
          existing.detail = `Peak ${Math.round(existing.maxDbm)} ${unit} (+${Math.round(existing.maxDbm - median)} ${diffUnit} above ${Math.round(median)} ${unit} median) · seen across ${existing.count} scan passes`;
        } else {
          this.scanFindings.unshift({
            id: ++this.scanFindingSeq,
            key,
            firstMs: now,
            lastMs: now,
            timeLabel: fmtWallTimeMs(now),
            tone: p.dbm >= strongThr ? "badge-warn" : "badge-accent",
            badge: p.dbm >= strongThr ? "Strong peak" : "RF peak",
            sourceLabel: `${p.freqMHz} MHz · ${p.bandHint}`,
            freqMHz: p.freqMHz,
            maxDbm: p.dbm,
            count: 1,
            detail: `Peak ${Math.round(p.dbm)} ${unit} (+${Math.round(p.dbm - median)} ${diffUnit} above ${Math.round(median)} ${unit} band median)`,
          });
        }
      }
    } else if (!s.live || this.scanFindings.length === 0) {
      const existingQuiet = this.scanFindings.find((e) => e.key === "quiet" && now - e.lastMs <= 10000);
      if (existingQuiet) {
        existingQuiet.lastMs = now;
        existingQuiet.count++;
        existingQuiet.detail = `No peaks ≥ ${minProm} ${diffUnit} above the ${Math.round(median)} ${unit} band median (${s.dbm.length} points, ${existingQuiet.count} passes).`;
      } else {
        this.scanFindings.unshift({
          id: ++this.scanFindingSeq,
          key: "quiet",
          firstMs: now,
          lastMs: now,
          timeLabel: fmtWallTimeMs(now),
          tone: "badge-good",
          badge: "Quiet band",
          sourceLabel: `${s.start}-${scanStop} MHz`,
          maxDbm: median,
          count: 1,
          detail: `No peaks ≥ ${minProm} ${diffUnit} above the ${Math.round(median)} ${unit} band median across ${s.dbm.length} points.`,
        });
      }
    }

    if (this.scanFindings.length > 100) {
      this.scanFindings.length = 100;
    }
  }

  private syncFindingsLogDom(
    host: HTMLElement,
    entries: FindingLogEntry[],
    clearAction: "clear-signal-findings" | "clear-scan-findings",
    emptyHint: string,
    isInScope?: (e: FindingLogEntry) => boolean
  ): void {
    let scrollEl = host.querySelector<HTMLElement>("[data-findings-scroll]");
    if (!scrollEl) {
      host.innerHTML = `
        <div class="debug-findings-head">
          <div class="debug-findings-title-group">
            <span class="debug-findings-title">Findings log</span>
            <span class="badge mono" data-findings-count>0</span>
            <span class="note debug-findings-sub" data-findings-sub>Newest first · coalesces ongoing bursts on the same channel</span>
          </div>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="${clearAction}" data-findings-clear disabled title="Clear findings log" aria-label="Clear findings log">${icons.trash(17)}</button>
        </div>
        <div class="debug-findings-scroll table-scroll" data-findings-scroll>
          <div class="debug-findings-empty note" data-findings-empty>${esc(emptyHint)}</div>
          <table class="debug-findings-table" data-findings-table hidden>
            <colgroup>
              <col class="col-finding-id" />
              <col class="col-finding-time" />
              <col class="col-finding-type" />
              <col class="col-finding-source" />
              <col class="col-finding-detail" />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Type</th>
                <th>Channel / Freq</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody data-findings-tbody></tbody>
          </table>
        </div>`;
      scrollEl = host.querySelector<HTMLElement>("[data-findings-scroll]")!;
    }

    const inScopeCount = isInScope ? entries.filter(isInScope).length : entries.length;
    const isFiltered = isInScope !== undefined && inScopeCount < entries.length;

    const countEl = host.querySelector<HTMLElement>("[data-findings-count]");
    if (countEl) {
      const nextCount = isFiltered ? `${inScopeCount} / ${entries.length}` : String(entries.length);
      if (countEl.textContent !== nextCount) countEl.textContent = nextCount;
    }

    const subEl = host.querySelector<HTMLElement>("[data-findings-sub]");
    if (subEl) {
      const nextSub = isFiltered
        ? "Highlighting selected scope · unselected channels faded (double-click a channel chip to solo)"
        : "Newest first · coalesces ongoing bursts on the same channel";
      if (subEl.textContent !== nextSub) subEl.textContent = nextSub;
    }

    const clearBtn = host.querySelector<HTMLButtonElement>("[data-findings-clear]");
    if (clearBtn) {
      clearBtn.disabled = entries.length === 0;
    }

    const emptyEl = host.querySelector<HTMLElement>("[data-findings-empty]");
    const tableEl = host.querySelector<HTMLTableElement>("[data-findings-table]");
    const tbody = host.querySelector<HTMLTableSectionElement>("[data-findings-tbody]");
    if (!emptyEl || !tableEl || !tbody) return;

    if (entries.length === 0) {
      emptyEl.hidden = false;
      tableEl.hidden = true;
      if (tbody.firstChild) tbody.innerHTML = "";
      return;
    }

    emptyEl.hidden = true;
    tableEl.hidden = false;
    tableEl.classList.toggle("is-scoped", isInScope !== undefined);

    // Map existing rows by finding ID so we never destroy the scroll container or existing row nodes
    const existingRows = new Map<number, HTMLTableRowElement>();
    Array.from(tbody.querySelectorAll<HTMLTableRowElement>("tr[data-finding-id]")).forEach((tr) => {
      existingRows.set(Number(tr.dataset.findingId), tr);
    });

    const validIds = new Set<number>(entries.map((e) => e.id));
    existingRows.forEach((tr, id) => {
      if (!validIds.has(id)) {
        tr.remove();
        existingRows.delete(id);
      }
    });

    const prevScrollTop = scrollEl.scrollTop;
    let newlyInsertedAtTop = 0;

    for (let idx = 0; idx < entries.length; idx++) {
      const e = entries[idx];
      const muted = isInScope ? !isInScope(e) : false;
      let tr = existingRows.get(e.id);
      if (!tr) {
        tr = document.createElement("tr");
        tr.dataset.findingId = String(e.id);
        tr.className = muted ? "is-muted" : "";
        tr.innerHTML = `
          <td class="mono note">#${e.id}</td>
          <td class="mono note" data-cell-time>${esc(e.timeLabel)}</td>
          <td><span class="badge ${e.tone}" data-cell-badge>${esc(e.badge)}</span></td>
          <td class="mono" data-cell-source>${e.sourceColor ? `<span class="debug-ch-inline" style="background:${e.sourceColor}"></span>` : ""}<strong>${esc(e.sourceLabel)}</strong></td>
          <td class="debug-finding-detail" data-cell-detail title="${esc(e.detail)}">${esc(e.detail)}</td>`;
        const refNode = tbody.children[idx] ?? null;
        tbody.insertBefore(tr, refNode);
        if (idx === newlyInsertedAtTop) {
          newlyInsertedAtTop++;
        }
      } else {
        tr.classList.toggle("is-muted", muted);
        const badgeEl = tr.querySelector<HTMLElement>("[data-cell-badge]");
        if (badgeEl) {
          const nextBadgeClass = `badge ${e.tone}`;
          if (badgeEl.className !== nextBadgeClass) badgeEl.className = nextBadgeClass;
          if (badgeEl.textContent !== e.badge) badgeEl.textContent = e.badge;
        }
        const detailEl = tr.querySelector<HTMLElement>("[data-cell-detail]");
        if (detailEl && detailEl.textContent !== e.detail) {
          detailEl.textContent = e.detail;
          detailEl.title = e.detail;
        }
        const curAtIdx = tbody.children[idx];
        if (curAtIdx !== tr) {
          tbody.insertBefore(tr, curAtIdx ?? null);
        }
      }
    }

    // If the user has scrolled down to read older findings and new rows arrived at the top, keep their viewport anchored
    if (prevScrollTop > 4 && newlyInsertedAtTop > 0) {
      let addedH = 0;
      for (let i = 0; i < newlyInsertedAtTop; i++) {
        const row = tbody.children[i] as HTMLElement | undefined;
        addedH += row?.offsetHeight || 29;
      }
      scrollEl.scrollTop = prevScrollTop + addedH;
    }
  }

  private renderNoiseTable(): void {
    const slotEl = this.slot("noise-table");
    if (this.isRotorHazardMode()) {
      const snap = this.activeRhSnapshot();
      const nCount = snap?.nodeCount === 4 ? 4 : 8;
      const rhFreqs = new Array<number>(8).fill(0).map((_, i) => snap?.nodeFreqsMhz[i] ?? 0);
      const perNodeEnter = new Array<number>(8).fill(90).map((_, i) => snap?.nodeEnterLevels[i] ?? 90);
      const perNodeExit = new Array<number>(8).fill(70).map((_, i) => snap?.nodeExitLevels[i] ?? 70);
      const nodeLabels = new Array<string>(8).fill("").map((_, i) => `N${i + 1}`);
      const summary = this.signalRing.computeStats(
        this.signalWindowSec,
        rhFreqs,
        [],
        10,
        this.signalEndN,
        this.signalEndN !== null ? this.signalRefN : null,
        {
          perNodeEnter,
          perNodeExit,
          nodeLabels,
          useMinAsFloor: true,
        }
      );
      const anyChDisabled = this.signalEnabledCh.slice(0, nCount).some((on) => !on);

      let findingsHost = slotEl.querySelector<HTMLElement>("[data-signal-findings-host]");
      let noiseTbody = slotEl.querySelector<HTMLTableSectionElement>("[data-noise-tbody]");
      if (!findingsHost || !noiseTbody || slotEl.dataset.noiseMode !== "rh") {
        slotEl.dataset.noiseMode = "rh";
        slotEl.innerHTML = `
          <div class="debug-findings" data-signal-findings-host role="region" aria-label="Signal findings log"></div>
          <div class="debug-subbox debug-noise-box">
            <div class="debug-subbar">
              <span class="debug-chart-title">Node noise &amp; threshold statistics</span>
            </div>
            <div class="debug-table-scroll table-scroll">
              <table class="debug-runs debug-noise-table">
                <thead>
                  <tr>
                    <th>Node / Freq</th>
                    <th>Enter / Exit</th>
                    <th>Mean</th>
                    <th>Spread (SD)</th>
                    <th>Max</th>
                    <th>Floor (Min)</th>
                    <th>Would trigger</th>
                  </tr>
                </thead>
                <tbody data-noise-tbody></tbody>
              </table>
            </div>
          </div>`;
        findingsHost = slotEl.querySelector<HTMLElement>("[data-signal-findings-host]")!;
        noiseTbody = slotEl.querySelector<HTMLTableSectionElement>("[data-noise-tbody]")!;
      }

      this.syncFindingsLogDom(
        findingsHost,
        this.signalFindings,
        "clear-signal-findings",
        "Waiting for ~10 Hz Socket.IO heartbeat samples. Node threshold crossings and RF spikes will be logged here with timestamps.",
        anyChDisabled ? (e) => e.channelIndex !== undefined && Boolean(this.signalEnabledCh[e.channelIndex]) : undefined
      );

      const on = Boolean(snap?.connected);
      const isLight = getAppTheme() === "light";
      noiseTbody.innerHTML = summary.rows
        .slice(0, nCount)
        .map((r) => {
          const col = channelColor(r.index);
          const trigRisk = r.pctWouldTrigger > 0;
          const chOn = this.signalEnabledCh[r.index];
          const f = r.freqMHz;
          const nodeLit = on && chOn && f > 0;
          const dotGlow = isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 6px ${col}`;
          const band = f > 0 ? hardwareBandLabel(f) : "";
          const freqStr = f > 0 ? `${band ? `${band} · ` : ""}${f} MHz` : "";
          const hasMean = f > 0 && r.mean !== null;
          const hasSd = f > 0 && r.sd !== null;
          const hasMax = f > 0 && r.max !== null;
          const hasFloor = f > 0 && r.floor !== null;
          const hasSamples = f > 0 && r.samples > 0;
          return `<tr class="${chOn ? "" : "is-muted"}">
            <td class="mono"><span class="debug-ch-inline" style="${nodeLit ? `background:${col};box-shadow:${dotGlow}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col};opacity:0.55`}"></span>${f > 0 ? `<strong>N${r.index + 1}</strong> · ${esc(freqStr)}` : `<span class="note">N${r.index + 1}</span>`}</td>
            <td class="mono note">${f > 0 ? `${r.enterThreshold} / ${r.exitThreshold ?? 70} RSSI` : "—"}</td>
            <td class="mono ${hasMean ? "" : "note"}">${hasMean ? `${r.mean!.toFixed(1)} RSSI` : "—"}</td>
            <td class="mono ${hasSd ? (r.sd! > 8 ? "debug-tone-warn" : "") : "note"}">${hasSd ? `${r.sd!.toFixed(1)}` : "—"}</td>
            <td class="mono ${hasMax ? "" : "note"}">${hasMax ? `${r.max} RSSI` : "—"}</td>
            <td class="mono ${hasFloor ? "" : "note"}">${hasFloor ? `${r.floor} RSSI` : "—"}</td>
            <td class="mono ${hasSamples && trigRisk ? "debug-tone-warn" : "note"}">${hasSamples ? `${r.pctWouldTrigger.toFixed(1)}% (${r.wouldTriggerPerSec.toFixed(1)}/s)` : "—"}</td>
          </tr>`;
        })
        .join("");
      return;
    }

    const freqs = this.status?.freqs ?? RACEBAND;
    const sweepHz = this.status?.sweepHz ?? 50;
    const summary = this.signalRing.computeStats(
      this.signalWindowSec,
      freqs,
      this.pilots,
      sweepHz,
      this.signalEndN,
      this.signalEndN !== null ? this.signalRefN : null
    );
    const anyChDisabled = this.signalEnabledCh.some((on) => !on);

    let findingsHost = slotEl.querySelector<HTMLElement>("[data-signal-findings-host]");
    let noiseTbody = slotEl.querySelector<HTMLTableSectionElement>("[data-noise-tbody]");
    if (!findingsHost || !noiseTbody || slotEl.dataset.noiseMode !== "slaprf") {
      slotEl.dataset.noiseMode = "slaprf";
      slotEl.innerHTML = `
        <div class="debug-findings" data-signal-findings-host role="region" aria-label="Signal findings log"></div>
        <div class="debug-subbox debug-noise-box">
          <div class="debug-subbar">
            <span class="debug-chart-title">Channel noise statistics</span>
          </div>
          <div class="debug-table-scroll table-scroll">
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
              <tbody data-noise-tbody></tbody>
            </table>
          </div>
        </div>`;
      findingsHost = slotEl.querySelector<HTMLElement>("[data-signal-findings-host]")!;
      noiseTbody = slotEl.querySelector<HTMLTableSectionElement>("[data-noise-tbody]")!;
    }

    this.syncFindingsLogDom(
      findingsHost,
      this.signalFindings,
      "clear-signal-findings",
      "Waiting for 50 Hz sweep samples. Threshold crossings and in-band RF bursts will be logged here with timestamps.",
      anyChDisabled ? (e) => e.channelIndex !== undefined && Boolean(this.signalEnabledCh[e.channelIndex]) : undefined
    );

    noiseTbody.innerHTML = summary.rows
      .map((r) => {
        const col = channelColor(r.index);
        const trigRisk = r.pctWouldTrigger > 0;
        const chOn = this.signalEnabledCh[r.index];
        return `<tr class="${chOn ? "" : "is-muted"}">
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
      .join("");
  }

  private renderScan(): void {
    if (!this.hasSpectrumScanSupport()) return;
    const isRHUSB = this.isRotorHazardUSBMode();
    const sb = this.scanYBounds();
    const rhSnap = isRHUSB ? this.activeRhSnapshot() : null;
    const on = isRHUSB ? Boolean(rhSnap?.connected) : this.console.connected;
    const emg = isRHUSB ? false : Boolean(on && this.status?.emergencyMode);
    const rfOn = isRHUSB ? on : !emg;
    const hasScan = this.spectrumAcc.latest !== null;
    const maxStop = sb.maxFreqMHz;
    const effStop = Math.min(maxStop, this.scanStopMHz);
    const isFull5 = this.scanStartMHz === 5180 && (this.scanStopMHz === 5945 || this.scanStopMHz === 5917) && this.scanStepMHz === 5;
    const isFast15 = this.scanStartMHz === 5180 && (this.scanStopMHz === 5945 || this.scanStopMHz === 5917) && this.scanStepMHz === 15;
    const isRb5 = (this.scanStartMHz === 5630 || this.scanStartMHz === 5650) && (this.scanStopMHz === 5945 || this.scanStopMHz === 5925 || this.scanStopMHz === 5917) && this.scanStepMHz === 5;
    const bandLabel = isFast15 ? "Fast · 9 Hz" : isRb5 ? "Race · 8 Hz" : "Full · 3 Hz";
    const isFreqZoomed = this.scanZoomStartMHz !== null && this.scanZoomStopMHz !== null;
    const isScanYZoomed = Math.round(this.scanYMin) !== sb.min || Math.round(this.scanYMax) !== sb.max;
    const isScanFullY = !this.scanAutoY && !isScanYZoomed;
    const isWfRowsZoomed = this.spectrumAcc.visibleRows !== 80;
    const xScanShort = !isFreqZoomed
      ? "Auto X"
      : (Math.round(this.scanZoomStartMHz!) === 5630 || Math.round(this.scanZoomStartMHz!) === 5650) &&
          (Math.round(this.scanZoomStopMHz!) === 5945 || Math.round(this.scanZoomStopMHz!) === 5917)
        ? "X: Race"
        : Math.round(this.scanZoomStartMHz!) === 5180 && Math.round(this.scanZoomStopMHz!) === 5320
          ? "X: UNII1"
          : Math.round(this.scanZoomStartMHz!) === 5725 && Math.round(this.scanZoomStopMHz!) === 5850
            ? "X: UNII3"
            : Math.abs(this.scanZoomStopMHz! - this.scanZoomStartMHz! - (effStop - this.scanStartMHz)) <= 2
              ? "X: Pan"
              : `X: ${Math.round(this.scanZoomStopMHz! - this.scanZoomStartMHz!)}M`;
    const yScanShort = this.scanAutoY
      ? "Auto Y"
      : sb.rssiScale
        ? `Y: ${Math.round(this.scanYMax - this.scanYMin)}`
        : `Y: ${Math.round(this.scanYMax - this.scanYMin)}dB`;
    const canScanOnce = on && rfOn && !this.scanning && !this.scanLive;
    const canScanLive = on && rfOn && !this.scanning;
    const scanActive = this.scanLive || this.scanning;
    const prevScanFindingsEl = this.slot("scan").querySelector<HTMLElement>("[data-scan-findings]");
    const prevScanScrollTop = prevScanFindingsEl?.querySelector<HTMLElement>("[data-findings-scroll]")?.scrollTop ?? 0;
    const wfRowPresets = [40, 80, 160, 300] as const;
    const idleNote = !on && isRHUSB ? "Offline · click Connect timer above" : "Paused";
    this.slot("scan").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${emg ? "is-emergency" : scanActive ? "is-up" : ""}" data-scan-led></span>
          <span class="debug-head-note" data-scan-status-note>${emg ? "Emergency mode · radio halted" : this.scanLive ? "Streaming · live scan" : this.scanning ? "Scanning once…" : idleNote}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm ${this.scanning ? "btn-armed" : "btn-unarmed"}" data-action="scan" ${canScanOnce ? "" : "disabled"} title="${this.scanLive ? "Unavailable while Spectrum scan is streaming" : !on ? "Connect a timer first to run Spectrum scan" : !rfOn ? "Unavailable while the 5.8 GHz receiver is off" : "Sweep the band once and add a row to the waterfall"}">
            ${icons.target(14)}<span>${this.scanning ? "Scanning…" : "Scan once"}</span>
          </button>
          <button type="button" class="btn btn-sm ${this.scanLive ? "btn-armed" : "btn-unarmed"}" data-action="scan-live" ${canScanLive ? "" : "disabled"} title="${!on ? "Connect a timer first to stream Spectrum scan" : !rfOn ? "Unavailable while the 5.8 GHz receiver is off" : this.scanLive ? "Streaming continuous spectrum scan · click to pause" : "Paused · click to stream continuous spectrum scan (automatically pauses node stream)"}">
            ${this.scanLive ? icons.pause(14) : icons.play(14)}<span>${this.scanLive ? "Pause" : "Stream"}</span>
          </button>
        </div>
      </div>
      <div class="debug-subbox">
        <div class="debug-subbar">
          <span class="debug-chart-title">Spectrum scan (${sb.rssiScale ? "0-255 RSSI" : "dBm"} × frequency)</span>
          <div class="debug-connect-actions">
            <div class="debug-overlay-checks" role="group" aria-label="Spectrum overlays">
              <label class="check" title="Show max-hold envelope">
                <input type="checkbox" data-check="scan-hold" ${this.scanShowMaxHold ? "checked" : ""}/>
                <span><span class="debug-hint-desktop">Max hold</span><span class="debug-hint-mobile">Max</span></span>
              </label>
              <label class="check" title="Show running average trace">
                <input type="checkbox" data-check="scan-avg" ${this.scanShowAvg ? "checked" : ""}/>
                <span>Average</span>
              </label>
              <label class="check" title="Show 5 GHz Wi-Fi UNII band overlay">
                <input type="checkbox" data-check="scan-wifi" ${this.scanShowWifi ? "checked" : ""}/>
                <span><span class="debug-hint-desktop">5 GHz Wi-Fi bands</span><span class="debug-hint-mobile">5 GHz Wi-Fi</span></span>
              </label>
              <span class="debug-overlay-sep" role="separator" aria-hidden="true"></span>
              <button type="button" class="debug-overlay-icon-btn" data-action="clear-hold" ${hasScan ? "" : "disabled"} aria-label="Reset max hold and running average" title="Reset max hold and running average">
                ${icons.reset(13)}
              </button>
            </div>
          </div>
        </div>
        <div class="debug-canvas-wrap">
          <canvas class="debug-canvas debug-spectrum-canvas" data-spectrum-canvas></canvas>
        </div>
        <div class="debug-chart-readout debug-single-readout" data-spectrum-readout></div>
        <div class="debug-chart-foot">
          <div class="debug-toolbar-left">
            <div class="debug-axis-pill ${!isFreqZoomed ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${!isFreqZoomed ? "toggle-axis-menu" : "scan-reset-zoom"}" data-menu="scan-x" title="${isFreqZoomed ? "Click to reset frequency zoom to Auto X" : "Full scanned frequency range · click to choose a frequency band preset, or drag X-axis to zoom"}">
                ${icons.target(13)}<span>${isFreqZoomed ? `<span class="debug-hint-desktop">X: ${Math.round(this.scanZoomStartMHz!)}-${Math.round(this.scanZoomStopMHz!)} MHz</span><span class="debug-hint-mobile">${xScanShort}</span>` : "Auto X"}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="scan-x" aria-expanded="${this.openAxisMenu === "scan-x"}" title="Choose frequency range">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "scan-x"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="Spectrum X-axis frequency range">
                      <button type="button" class="debug-axis-menu-item ${!isFreqZoomed ? "is-active" : ""}" data-action="scan-reset-zoom" role="menuitem">
                        <span>Auto X</span><span class="note">Full scan</span>
                      </button>
                      <div class="debug-axis-menu-sep"></div>
                      <button type="button" class="debug-axis-menu-item ${isFreqZoomed && Math.round(this.scanZoomStartMHz!) === 5630 && Math.round(this.scanZoomStopMHz!) === maxStop ? "is-active" : ""}" data-action="scan-zoom-range" data-start="5630" data-stop="${maxStop}" role="menuitem">
                        <span>Raceband</span><span class="note">5630-${maxStop} MHz</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${isFreqZoomed && Math.round(this.scanZoomStartMHz!) === 5180 && Math.round(this.scanZoomStopMHz!) === 5320 ? "is-active" : ""}" data-action="scan-zoom-range" data-start="5180" data-stop="5320" role="menuitem">
                        <span>UNII-1</span><span class="note">5180-5320 MHz</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${isFreqZoomed && Math.round(this.scanZoomStartMHz!) === 5725 && Math.round(this.scanZoomStopMHz!) === 5850 ? "is-active" : ""}" data-action="scan-zoom-range" data-start="5725" data-stop="5850" role="menuitem">
                        <span>UNII-3</span><span class="note">5725-5850 MHz</span>
                      </button>
                    </div>`
                  : ""
              }
            </div>
            <div class="debug-axis-pill ${isScanFullY ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${isScanFullY ? "toggle-axis-menu" : "scan-full-y"}" data-menu="scan-y" title="${isScanFullY ? `Full Y-axis scale (${sb.min}…${sb.max} ${sb.unit}) · click to choose a scale preset, or drag the Y-axis` : "Click to reset Y-axis range to Full Y"}">
                ${icons.target(13)}<span>${isScanFullY ? "Full Y" : this.scanAutoY ? "Auto Y" : `<span class="debug-hint-desktop">Y: ${Math.round(this.scanYMin)}…${Math.round(this.scanYMax)} ${sb.unit}</span><span class="debug-hint-mobile">${yScanShort}</span>`}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="scan-y" aria-expanded="${this.openAxisMenu === "scan-y"}" title="Choose spectrum Y-axis ${sb.unit} scale">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "scan-y"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="Spectrum Y-axis ${sb.unit} scale">
                      <button type="button" class="debug-axis-menu-item ${isScanFullY ? "is-active" : ""}" data-action="scan-full-y" role="menuitem">
                        <span>Full Y</span><span class="note">${sb.min}…${sb.max} ${sb.unit}</span>
                      </button>
                      <div class="debug-axis-menu-sep"></div>
                      <button type="button" class="debug-axis-menu-item ${this.scanAutoY ? "is-active" : ""}" data-action="scan-auto-y" data-force="1" role="menuitem">
                        <span>Auto Y</span><span class="note">Fit scan</span>
                      </button>
                    </div>`
                  : ""
              }
            </div>
            <div class="debug-axis-pill ${isFull5 ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${isFull5 ? "toggle-axis-menu" : "scan-preset"}" data-menu="scan-band" data-start="5180" data-stop="${maxStop}" data-step="5" title="${isFull5 ? `Band sweep preset (${this.scanStartMHz}-${effStop} MHz, ${this.scanStepMHz} MHz step) · click to choose a band sweep preset` : `Click to reset band sweep to Full · 3 Hz (5180-${maxStop} MHz, 5 MHz step)`}">
                ${icons.sliders(13)}<span>${bandLabel}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="scan-band" aria-expanded="${this.openAxisMenu === "scan-band"}" title="Choose band sweep preset">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "scan-band"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="Band sweep range and speed">
                      <button type="button" class="debug-axis-menu-item ${isFull5 ? "is-active" : ""}" data-action="scan-preset" data-start="5180" data-stop="${maxStop}" data-step="5" role="menuitem" title="Full 5.18-${(maxStop / 1000).toFixed(2)} GHz band at 5 MHz step">
                        <span>Full · 3 Hz</span><span class="note">5180-${maxStop} · 5 MHz</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${isFast15 ? "is-active" : ""}" data-action="scan-preset" data-start="5180" data-stop="${maxStop}" data-step="15" role="menuitem" title="Full 5.18-${(maxStop / 1000).toFixed(2)} GHz band at 15 MHz step">
                        <span>Fast · 9 Hz</span><span class="note">5180-${maxStop} · 15 MHz</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${isRb5 ? "is-active" : ""}" data-action="scan-preset" data-start="5630" data-stop="${maxStop}" data-step="5" role="menuitem" title="Raceband R1-R8 + Wi-Fi UNII-3 at 5 MHz step">
                        <span>Race · 8 Hz</span><span class="note">5630-${maxStop} · 5 MHz</span>
                      </button>
                    </div>`
                  : ""
              }
            </div>
          </div>
          <span class="note debug-chart-hint"><span class="debug-hint-desktop">Drag chart to pan · Shift+drag box to zoom · drag axes to stretch</span><span class="debug-hint-mobile">Drag chart to pan · drag axes to stretch · double-tap to reset</span></span>
          <div class="debug-connect-actions">
            <div class="debug-btn-group" role="group" aria-label="Export spectrum chart">
              <button type="button" class="btn btn-sm btn-ghost" data-action="export-spectrum-csv" ${hasScan ? "" : "disabled"} title="Download spectrum trace (latest, average, max-hold) as CSV">CSV</button>
              <button type="button" class="btn btn-sm btn-ghost" data-action="export-spectrum-png" ${hasScan ? "" : "disabled"} title="Save spectrum trace chart as PNG">PNG</button>
            </div>
          </div>
        </div>
      </div>
      <div class="debug-findings debug-scan-findings" data-scan-findings role="region" aria-label="Spectrum findings log"></div>
      <div class="debug-subbox debug-waterfall-section">
        <div class="debug-subbar debug-waterfall-head">
          <div class="debug-waterfall-title-group">
            <span class="debug-chart-title">Waterfall spectrogram (frequency × time)</span>
            <span class="note" data-wf-scroll-note></span>
          </div>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-action="wf-jump-live" data-wf-jump-btn disabled>Jump to live</button>
            <div class="debug-waterfall-legend mono" title="Color scale follows Spectrum Y-axis range">
              <span data-wf-color-min>${this.spectrumAcc.colorMinDbm} ${sb.unit}</span>
              <span class="debug-wf-gradient"></span>
              <span data-wf-color-max>${this.spectrumAcc.colorMaxDbm} ${sb.unit}</span>
            </div>
          </div>
        </div>
        <div class="debug-canvas-wrap">
          <canvas class="debug-canvas debug-waterfall-canvas" data-waterfall-canvas></canvas>
        </div>
        <div class="debug-chart-readout debug-single-readout" data-waterfall-readout></div>
        <div class="debug-chart-foot">
          <div class="debug-toolbar-left">
            <div class="debug-axis-pill ${!isFreqZoomed ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${!isFreqZoomed ? "toggle-axis-menu" : "scan-reset-zoom"}" data-menu="wf-x" title="${isFreqZoomed ? "Click to reset frequency zoom to Auto X" : "Full scanned frequency range · click to choose a frequency band preset, or drag X-axis to zoom"}">
                ${icons.target(13)}<span>${isFreqZoomed ? `<span class="debug-hint-desktop">X: ${Math.round(this.scanZoomStartMHz!)}-${Math.round(this.scanZoomStopMHz!)} MHz</span><span class="debug-hint-mobile">${xScanShort}</span>` : "Auto X"}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="wf-x" aria-expanded="${this.openAxisMenu === "wf-x"}" title="Choose frequency range">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "wf-x"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="Waterfall X-axis frequency range">
                      <button type="button" class="debug-axis-menu-item ${!isFreqZoomed ? "is-active" : ""}" data-action="scan-reset-zoom" role="menuitem">
                        <span>Auto X</span><span class="note">Full scan</span>
                      </button>
                      <div class="debug-axis-menu-sep"></div>
                      <button type="button" class="debug-axis-menu-item ${isFreqZoomed && Math.round(this.scanZoomStartMHz!) === 5630 && Math.round(this.scanZoomStopMHz!) === maxStop ? "is-active" : ""}" data-action="scan-zoom-range" data-start="5630" data-stop="${maxStop}" role="menuitem">
                        <span>Raceband</span><span class="note">5630-${maxStop} MHz</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${isFreqZoomed && Math.round(this.scanZoomStartMHz!) === 5180 && Math.round(this.scanZoomStopMHz!) === 5320 ? "is-active" : ""}" data-action="scan-zoom-range" data-start="5180" data-stop="5320" role="menuitem">
                        <span>UNII-1</span><span class="note">5180-5320 MHz</span>
                      </button>
                      <button type="button" class="debug-axis-menu-item ${isFreqZoomed && Math.round(this.scanZoomStartMHz!) === 5725 && Math.round(this.scanZoomStopMHz!) === 5850 ? "is-active" : ""}" data-action="scan-zoom-range" data-start="5725" data-stop="5850" role="menuitem">
                        <span>UNII-3</span><span class="note">5725-5850 MHz</span>
                      </button>
                    </div>`
                  : ""
              }
            </div>
            <div class="debug-axis-pill ${!isWfRowsZoomed ? "is-armed" : "is-unarmed"}" data-axis-pill>
              <button type="button" class="debug-axis-pill-main" data-action="${!isWfRowsZoomed ? "toggle-axis-menu" : "wf-reset-rows"}" data-menu="wf-y" title="${!isWfRowsZoomed ? "Auto Y waterfall depth (80 passes) · click to choose a pass depth, or drag the Y-axis" : "Click to reset waterfall pass depth to Auto Y (80 passes)"}">
                ${icons.target(13)}<span>${!isWfRowsZoomed ? "Auto Y" : `<span class="debug-hint-desktop">Y: ${this.spectrumAcc.visibleRows} passes</span><span class="debug-hint-mobile">Y: ${this.spectrumAcc.visibleRows}p</span>`}</span>
              </button>
              <button type="button" class="debug-axis-pill-arrow" data-action="toggle-axis-menu" data-menu="wf-y" aria-expanded="${this.openAxisMenu === "wf-y"}" title="Choose waterfall vertical pass depth">
                ${icons.chevronDown(12)}
              </button>
              ${
                this.openAxisMenu === "wf-y"
                  ? `<div class="debug-axis-menu" role="menu" aria-label="Waterfall pass depth">
                      <button type="button" class="debug-axis-menu-item ${!isWfRowsZoomed ? "is-active" : ""}" data-action="wf-rows" data-rows="80" role="menuitem">
                        <span>Auto Y</span><span class="note">80 passes</span>
                      </button>
                      <div class="debug-axis-menu-sep"></div>
                      ${wfRowPresets
                        .map((r) => {
                          const active = isWfRowsZoomed && this.spectrumAcc.visibleRows === r;
                          return `<button type="button" class="debug-axis-menu-item ${active ? "is-active" : ""}" data-action="wf-rows" data-rows="${r}" role="menuitem"><span>${r} passes</span></button>`;
                        })
                        .join("")}
                    </div>`
                  : ""
              }
            </div>
          </div>
          <span class="note debug-chart-hint"><span class="debug-hint-desktop">Drag chart to pan · Shift+drag box to zoom · drag axes to stretch</span><span class="debug-hint-mobile">Drag chart to pan · drag axes to stretch · double-tap to reset</span></span>
          <div class="debug-connect-actions">
            <div class="debug-btn-group" role="group" aria-label="Export waterfall spectrogram">
              <button type="button" class="btn btn-sm btn-ghost" data-action="export-scan-csv" ${hasScan ? "" : "disabled"} title="Download waterfall scan history matrix as CSV">CSV</button>
              <button type="button" class="btn btn-sm btn-ghost" data-action="export-waterfall-png" ${hasScan ? "" : "disabled"} title="Save waterfall spectrogram as PNG">PNG</button>
            </div>
          </div>
        </div>
      </div>`;
    if (prevScanFindingsEl) {
      const placeholder = this.slot("scan").querySelector<HTMLElement>("[data-scan-findings]");
      if (placeholder) {
        placeholder.replaceWith(prevScanFindingsEl);
        const sc = prevScanFindingsEl.querySelector<HTMLElement>("[data-findings-scroll]");
        if (sc && prevScanScrollTop > 0) sc.scrollTop = prevScanScrollTop;
      }
    }
    this.updateScanFindings();
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
  }

  private updateScanFindings(): void {
    const isRHUSB = this.isRotorHazardUSBMode();
    const s = this.spectrumAcc.latest;
    const rhOn = isRHUSB ? Boolean(this.activeRhSnapshot()?.connected) : false;
    const emg = isRHUSB ? false : Boolean(this.console.connected && this.status?.emergencyMode);
    const scanLed = this.el.querySelector<HTMLElement>("[data-scan-led]");
    const scanNote = this.el.querySelector<HTMLElement>("[data-scan-status-note]");
    if (scanLed) {
      scanLed.classList.toggle("is-emergency", emg);
      scanLed.classList.toggle("is-up", !emg && (this.scanLive || this.scanning));
    }
    if (scanNote) {
      if (emg) {
        scanNote.textContent = "Emergency mode · radio halted";
      } else if (this.scanLive) {
        const rateStr = s?.live && s.passMs ? `${(1000 / s.passMs).toFixed(1)} passes/s` : "live";
        scanNote.textContent = `Streaming · ${rateStr} · ${this.spectrumAcc.avgCount} avg`;
      } else if (this.scanning) {
        scanNote.textContent = "Scanning once…";
      } else if (s) {
        scanNote.textContent = `Paused · ${s.dbm.length} pts`;
      } else if (isRHUSB && !rhOn) {
        scanNote.textContent = "Offline · click Connect timer above";
      } else {
        scanNote.textContent = "Paused";
      }
    }

    if (s) {
      this.slot("scan")
        .querySelectorAll<HTMLButtonElement>(
          '[data-action="clear-hold"],[data-action="export-spectrum-csv"],[data-action="export-spectrum-png"],[data-action="export-scan-csv"],[data-action="export-waterfall-png"]'
        )
        .forEach((b) => {
          if (b.disabled) b.disabled = false;
        });
    }

    const el = this.el.querySelector<HTMLElement>("[data-scan-findings]");
    if (el) {
      const z0 = this.scanZoomStartMHz;
      const z1 = this.scanZoomStopMHz;
      const isZoomed = z0 !== null && z1 !== null;
      const emptyHint = isRHUSB
        ? "Run Scan once or click Stream. Detected RF peaks (≥ 18 RSSI above band median) and 5 GHz Wi-Fi activity will be logged here with timestamps."
        : "Run Scan once or click Stream. Detected RF peaks (≥ 6 dB above band median) and 5 GHz Wi-Fi activity will be logged here with timestamps.";
      this.syncFindingsLogDom(
        el,
        this.scanFindings,
        "clear-scan-findings",
        emptyHint,
        isZoomed ? (e) => e.freqMHz !== undefined && e.freqMHz >= z0! && e.freqMHz <= z1! : undefined
      );
    }

    const wfNote = this.el.querySelector<HTMLElement>("[data-wf-scroll-note]");
    const wfJumpBtn = this.el.querySelector<HTMLButtonElement>("[data-wf-jump-btn]");
    const total = this.spectrumAcc.history.length;
    const vis = this.spectrumAcc.visibleRows;
    const sc = this.spectrumAcc.scrollRow;
    if (wfNote) {
      if (!total) {
        wfNote.textContent = "";
      } else if (sc > 0) {
        wfNote.textContent = `· rows -${sc + 1}..-${Math.min(total, sc + vis)} of ${total}`;
      } else if (total > vis) {
        wfNote.textContent = `· top ${vis} of ${total} passes`;
      } else {
        wfNote.textContent = `· ${total} pass${total === 1 ? "" : "es"}`;
      }
    }
    if (wfJumpBtn) {
      wfJumpBtn.disabled = sc <= 0;
    }
  }

  private bootLogHeader(l: BootLog): string {
    return `${l.which === "last" ? "Previous boot" : "This boot"} · boot #${l.boots} · restart reason: ${l.reset}`;
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

  private serialPrompt(): string {
    if (!this.console.connected) return "slaprf>";
    const name = this.status?.label || this.status?.fp || "timer";
    return `slaprf@${name}>`;
  }

  private scrollSerialToBottom(focusInput = false): void {
    const apply = () => {
      const term = this.el.querySelector<HTMLElement>("[data-serial-terminal]");
      if (term) {
        term.scrollTop = term.scrollHeight;
      }
      if (focusInput) {
        const inp = this.el.querySelector<HTMLInputElement>("[data-serial-input]");
        if (inp && !inp.disabled) {
          inp.focus({ preventScroll: true });
        }
      }
    };
    apply();
    window.requestAnimationFrame(apply);
  }

  private appendSerialLine(line: string): void {
    this.serialLines.push(line);
    if (this.serialLines.length > LOG_LINES) {
      this.serialLines.splice(0, this.serialLines.length - LOG_LINES);
    }
    const pre = this.el.querySelector<HTMLElement>("[data-serial-pre]");
    if (pre) {
      pre.textContent = this.serialLines.join("\n") + (this.serialLines.length ? "\n" : "");
    }
    const ps1El = this.el.querySelector<HTMLElement>("[data-serial-ps1]");
    if (ps1El) {
      ps1El.textContent = this.serialPrompt();
    }
    const note = this.el.querySelector<HTMLElement>("[data-serial-note]");
    if (note && this.console.connected && !this.busy) {
      note.textContent = `Connected · ${this.serialLines.length} lines · type HELP for commands`;
    }
    this.el.querySelector<HTMLButtonElement>('[data-action="copy-serial"]')?.removeAttribute("disabled");
    this.el.querySelector<HTMLButtonElement>('[data-action="serial-clear"]')?.removeAttribute("disabled");
    this.scrollSerialToBottom();
  }

  private async sendSerialCommand(rawCmd: string): Promise<void> {
    const cmd = rawCmd.trim();
    const inp = this.el.querySelector<HTMLInputElement>("[data-serial-input]");
    if (inp) inp.value = "";
    if (!cmd) {
      this.appendSerialLine(this.serialPrompt());
      this.scrollSerialToBottom(true);
      return;
    }
    if (!this.serialHistory.length || this.serialHistory[this.serialHistory.length - 1] !== cmd) {
      this.serialHistory.push(cmd);
      if (this.serialHistory.length > 50) this.serialHistory.shift();
    }
    this.serialHistoryIdx = -1;
    this.serialDraft = "";

    const upper = cmd.toUpperCase();
    if (upper === "CLEAR" || upper === "CLS") {
      this.serialLines = [];
      this.renderSerialConsole();
      this.scrollSerialToBottom(true);
      return;
    }

    this.appendSerialLine(`${this.serialPrompt()} ${cmd}`);
    if (upper === "HELP" || upper === "HELP?" || upper === "?") {
      const helpLines = [
        "Commands:",
        "  STATUS?              identity, uptime, reset reason, heap, RF, channels",
        "  RF [1|0]             switch 5.8 GHz receiver on (1) or off (0)",
        "  LIVE [0|1|2]         stream 5.8 GHz readings (0=off, 1=10 Hz, 2=50 Hz every sweep)",
        "  SCAN <a b s>         single spectrum sweep a..b MHz in s MHz steps (e.g. SCAN 5650 5917 5)",
        "  SCAN LIVE <a b s>    continuous spectrum sweep (SCAN STOP to end)",
        "  CHANNELS <f1,..,f8>  set 8 channels in MHz (5180..5917, or 0 to disable a slot)",
        "  CHANNELS MASK <0..255> enable/disable channel slots by bitmask (CHANNELS RESET to restore)",
        "  LOG [1|0]            mirror ESP-IDF log output onto USB serial",
        "  BOOTLOG? / LASTLOG?  print current or previous boot log from RTC memory",
        "  SLAPRF?              read 160-byte SLAPRF02 configuration block",
        "  REBOOT               restart timer and reconnect",
        "  CLEAR                clear terminal screen",
      ];
      for (const l of helpLines) this.appendSerialLine(l);
      this.scrollSerialToBottom(true);
      return;
    }

    if (!this.console.connected) {
      this.appendSerialLine("error: not connected over USB");
      this.scrollSerialToBottom(true);
      return;
    }

    try {
      if (upper === "REBOOT") {
        this.serialAwaitUntil = Date.now() + 4000;
        const doRestart = async (): Promise<TimerStatus> => this.restart("REBOOT");
        let s: TimerStatus | null = null;
        if (this.busy) {
          s = await doRestart();
        } else {
          await this.runBusy("Restarting", async () => {
            s = await doRestart();
          });
        }
        this.appendSerialLine(
          s
            ? `Timer restarted and reconnected (boot #${s.boots}, reset: ${s.reset}).`
            : "Timer restarted and reconnected."
        );
        this.scrollSerialToBottom(true);
        return;
      }

      if (upper === "STATUS?") {
        this.serialExpectStatus = true;
      }
      this.serialAwaitUntil = Date.now() + 3000;
      if (upper === "BOOTLOG?" || upper === "LASTLOG?") {
        await this.console.request<BootLog>(cmd, "bootlog", 3000);
        this.scrollSerialToBottom(true);
        return;
      }
      await this.console.send(cmd);
      if (
        upper.startsWith("RF ") ||
        upper.startsWith("CHANNELS") ||
        upper.startsWith("SCAN STOP")
      ) {
        if (upper.startsWith("CHANNELS")) {
          this.chanMaskToggledAt = 0;
        }
        await sleep(150);
        try {
          this.status = await this.refreshStatus();
          if (this.status.chanMask !== undefined) {
            this.signalEnabledCh = Array.from({ length: 8 }, (_, i) => ((this.status!.chanMask! >> i) & 1) !== 0);
          }
          this.renderAll();
        } catch {
          this.status = await this.restart("REBOOT");
          this.renderAll();
        }
      }
    } catch (err) {
      this.appendSerialLine(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.scrollSerialToBottom(true);
  }

  private renderSerialConsole(): void {
    const on = this.console.connected;
    const busy = this.busy !== null;
    const restartBusy = this.busy === "Restarting" || this.busy === "Restart test";
    const ledClass = restartBusy ? "is-warn" : on ? "is-up" : "";
    const statusText = restartBusy && this.progress
      ? this.progress
      : !on
        ? "Off · connect a timer first"
        : `Connected · ${this.serialLines.length} lines · type HELP for commands`;
    const introBanner = on
      ? "# SlapRF USB serial terminal · type HELP for commands, Up/Down for history, Tab to complete.\n"
      : "# Disconnected · connect a timer over USB to open an interactive serial session.\n";
    const bodyRaw = this.serialLines.length
      ? this.serialLines.join("\n") + "\n"
      : introBanner;
    const ps1Raw = this.serialPrompt();

    const host = this.slot("serial-console");
    let term = host.querySelector<HTMLElement>("[data-serial-terminal]");
    if (!term) {
      host.innerHTML = `
        <div class="debug-card-head debug-log-head">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}" data-serial-led></span>
            <span class="debug-head-note" data-serial-note>${esc(statusText)}</span>
          </span>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="bootlog" title="Read this boot's log (BOOTLOG?)" aria-label="Read this boot's log">${icons.fileText(17)}</button>
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="lastlog" title="Read previous boot's log (LASTLOG?)" aria-label="Read previous boot's log">${icons.history(17)}</button>
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="serial-help" title="Show commands (HELP)" aria-label="Show commands">${icons.help(17)}</button>
            <span class="debug-action-sep" role="separator" aria-hidden="true"></span>
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="serial-wrap" aria-label="Wrap lines">${this.serialWrap ? icons.wrapText(17) : icons.wrapTextOff(17)}</button>
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="copy-serial" title="Copy terminal output" aria-label="Copy terminal output">${icons.copy(17)}</button>
            <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="serial-clear" title="Clear terminal (CLEAR)" aria-label="Clear terminal">${icons.trash(17)}</button>
          </div>
        </div>
        <div class="table-scroll">
          <div class="debug-log debug-terminal mono ${this.serialWrap ? "is-wrapped" : ""}" data-serial-terminal>
            <div class="debug-terminal-history" data-serial-pre></div>
            <div class="debug-terminal-cmdline">
              <span class="debug-terminal-ps1" data-serial-ps1></span>
              <input type="text" class="debug-terminal-input mono" data-serial-input ${on ? "" : "disabled"} autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Serial terminal command line"/>
            </div>
          </div>
        </div>`;
      term = host.querySelector<HTMLElement>("[data-serial-terminal]")!;
    }

    const ledEl = host.querySelector<HTMLElement>("[data-serial-led]");
    if (ledEl) ledEl.className = `status-dot ${ledClass}`;
    const noteEl = host.querySelector<HTMLElement>("[data-serial-note]");
    if (noteEl) noteEl.textContent = statusText;

    const bootlogBtn = host.querySelector<HTMLButtonElement>('[data-action="bootlog"]');
    if (bootlogBtn) bootlogBtn.disabled = !on || busy;
    const lastlogBtn = host.querySelector<HTMLButtonElement>('[data-action="lastlog"]');
    if (lastlogBtn) lastlogBtn.disabled = !on || busy;
    const helpBtn = host.querySelector<HTMLButtonElement>('[data-action="serial-help"]');
    if (helpBtn) helpBtn.disabled = busy;

    const wrapBtn = host.querySelector<HTMLButtonElement>('[data-action="serial-wrap"]');
    if (wrapBtn) {
      wrapBtn.setAttribute("aria-pressed", String(this.serialWrap));
      wrapBtn.title = this.serialWrap ? "Wrap lines: ON (click to disable)" : "Wrap lines: OFF (click to enable)";
      wrapBtn.innerHTML = this.serialWrap ? icons.wrapText(17) : icons.wrapTextOff(17);
    }
    const copyBtn = host.querySelector<HTMLButtonElement>('[data-action="copy-serial"]');
    if (copyBtn) copyBtn.disabled = !this.serialLines.length;
    const clearBtn = host.querySelector<HTMLButtonElement>('[data-action="serial-clear"]');
    if (clearBtn) clearBtn.disabled = !this.serialLines.length;

    term.classList.toggle("is-wrapped", this.serialWrap);
    const preEl = host.querySelector<HTMLElement>("[data-serial-pre]");
    if (preEl && preEl.textContent !== bodyRaw) {
      preEl.textContent = bodyRaw;
    }
    const ps1El = host.querySelector<HTMLElement>("[data-serial-ps1]");
    if (ps1El && ps1El.textContent !== ps1Raw) {
      ps1El.textContent = ps1Raw;
    }
    const inpEl = host.querySelector<HTMLInputElement>("[data-serial-input]");
    if (inpEl) {
      inpEl.disabled = !on;
    }
    if (this.serialLines.length) {
      this.scrollSerialToBottom();
    }
  }

  private renderLog(): void {
    const on = this.console.connected;
    const emg = Boolean(on && this.status?.emergencyMode);
    const active = on && this.logOn;
    this.slot("log").innerHTML = `
      <div class="debug-card-head debug-log-head">
        <span class="debug-led-status">
          <span class="status-dot ${emg ? "is-emergency" : active ? "is-up" : ""}"></span>
          <span class="debug-head-note" data-log-count>${active ? "Streaming" : "Paused"} · ${this.logLines.length} lines</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="log-wrap" aria-pressed="${this.logWrap}" title="${this.logWrap ? "Wrap lines: ON (click to disable)" : "Wrap lines: OFF (click to enable)"}" aria-label="Wrap lines">${this.logWrap ? icons.wrapText(17) : icons.wrapTextOff(17)}</button>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="clear-log" title="Clear live log" aria-label="Clear live log">${icons.trash(17)}</button>
          <button type="button" class="btn btn-sm ${this.logOn ? "btn-armed" : "btn-unarmed"}" data-action="log" ${on ? "" : "disabled"} title="${this.logOn ? "Streaming USB log mirror · click to pause" : "Paused · click to stream USB log mirror"}">
            ${this.logOn ? icons.pause(14) : icons.play(14)}<span>${this.logOn ? "Pause" : "Stream"}</span>
          </button>
        </div>
      </div>
      <div class="table-scroll">
        <pre class="debug-log mono ${this.logWrap ? "is-wrapped" : ""}" data-log-pre>${esc(this.logLines.join("\n"))}</pre>
      </div>`;
  }
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}
