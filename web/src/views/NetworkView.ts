import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { getAppTheme, subscribeAppTheme } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { capabilitiesSnapshot, resolveBackendUrl } from "../services/capabilities";
import {
  LapRFDiscoveredDevice,
  sharedLapRFLink,
} from "../services/laprf_hardware_link";
import {
  DEFAULT_RH_ADMIN_PASS,
  DEFAULT_RH_ADMIN_USER,
  DEFAULT_RH_PORT,
  RHDiscoveredDevice,
  RHUSBPortInfo,
  sharedRHLink,
} from "../services/rh_hardware_link";
import {
  LiveSample,
  sharedTimerConsole,
  TimerConsole,
  TimerStatus,
  usbPool,
} from "../services/timer_console";
import { timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { DetectedTimer, isRotorHazardMode, isSlapRFMode } from "../types/models";
import { patchUsbConnectionBar } from "../widgets/UsbConnectionBar";
import { channelColor, DBM_MAX, DBM_MIN, formatHardwareFreq, RACEBAND, racebandName } from "./debug/charts";

const NETWORK_PREFS_KEY = "slaprf.ui.network_prefs.v1";

function fmtCompactFrameCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtRateBadgeHtml(rate: number): string {
  const clamped = Math.min(999.9, Math.max(0, Number.isFinite(rate) ? rate : 0));
  return `<span class="net-metric-pair"><span class="net-num-slot is-rate">${clamped.toFixed(1)}</span> <span>pkt/s</span></span>`;
}

function fmtFramesBadgeHtml(frames: number): string {
  return `<span class="net-metric-pair"><span class="net-num-slot is-frames">${fmtCompactFrameCount(frames)}</span> <span class="net-unit-desktop">frames rx</span><span class="net-unit-mobile">fr rx</span></span>`;
}

function fmtKpiFramesHtml(frames: number, rate: number): string {
  const clamped = Math.min(999.9, Math.max(0, Number.isFinite(rate) ? rate : 0));
  return `<span class="net-metric-pair"><span class="net-num-slot is-frames">${fmtCompactFrameCount(frames)}</span> <span class="note">(<span class="net-metric-pair"><span class="net-num-slot is-rate">${clamped.toFixed(1)}</span> <span>pkt/s</span></span>)</span></span>`;
}

function fmtMsAgoHtml(ms: number): string {
  const clamped = Math.min(9999, Math.max(0, Math.round(ms)));
  return `<span class="net-metric-pair"><span class="net-num-slot is-ms">${clamped}</span> <span>ms ago</span></span>`;
}

interface TopologyHubInfo {
  populated: boolean;
  online: boolean;
  label: string;
  fp: string;
  fw: string;
  mac: string;
  ch: number;
  viaUsb: boolean;
  emergencyMode: boolean;
  gateLabel?: string;
  serverFrames?: number;
  dbm?: number[];
  statusNote: string;
}

interface TopologySpokeInfo {
  slot: number;
  populated: boolean;
  /** True when the 2.4 GHz ESP-NOW link is actively streaming/synced (renders solid; false renders dashed). */
  espNowActive: boolean;
  inHubStatus: boolean;
  viaUsb: boolean;
  label: string;
  fp: string;
  fw: string;
  mac?: string;
  frames: number;
  msAgo?: number;
  beaconMsAgo?: number;
  seq?: number;
  dbm?: number[];
  ratePktPerSec: number;
  serverFrames: number;
  serverGateLabel?: string;
  serverRssi?: number[];
  sourceNote: string;
}

/**
 * Dedicated Network page (`#/network`):
 * 1. Topology: Hub-and-Spoke radial/star diagram with Hub (Slot 1) in the center and 6 Spoke slots (Slots 2–7) around it.
 *    Active ESP-NOW links render solid; inactive/open slots render dashed.
 * 2. Timer: Inspector section below Topology showing the details and 5.8 GHz channel readings of the selected timer.
 */
export class NetworkView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly console: TimerConsole;
  private status: TimerStatus | null = null;
  private live: LiveSample | null = null;
  private liveAtMs = 0;
  /** Selected TDMA slot in the topology (1 = Center Hub, 2..7 = Child Spokes). */
  private selectedSlot: number | null = null;
  private userPickedSlot = false;
  private spokeRateTracker = new Map<number, { frames: number; atMs: number; ratePktPerSec: number }>();
  private signalEnabledCh: boolean[] = [true, true, true, true, true, true, true, true];
  private lastTopologyHtml = "";
  private lastTopologyStructKey = "";
  private lastTimerHtml = "";
  private lastTimerStructKey = "";
  private rafId = 0;
  private showAllPorts = false;
  private connError: string | null = null;
  /** Identify toggles sent but not yet confirmed by a status line (fingerprint -> wanted state). */
  private identifyPending = new Map<string, { on: boolean; atMs: number }>();
  /** True while "All Raceband" band survey is active (Hub & Spokes sweep R1..R8). */
  private surveyAllRaceband = false;
  private surveyError: string | null = null;
  private surveyLeaseTimer: number | null = null;
  private didResetTempHubChannels = false;
  private isViewActive = true;

  private laprfHost = "192.168.1.2";
  private laprfPort = 5403;
  private laprfBusy = false;
  private laprfScanning = false;
  private laprfScannedSubnet = "";
  private laprfDiscovered: LapRFDiscoveredDevice[] = [];
  private laprfError: string | null = null;
  private lastLaprfConnSig = "";
  private lastLaprfTimersStructSig = "";
  private livePollTimer: number | null = null;
  private livePollInFlight = false;
  private livePollTick = 0;

  private rhHost = "192.168.1.101";
  private rhPort = DEFAULT_RH_PORT;
  private rhUser = DEFAULT_RH_ADMIN_USER;
  private rhPass = DEFAULT_RH_ADMIN_PASS;
  private rhRevealPass = false;
  private rhCredPrompt: {
    scope: "manual" | "discovered" | "card";
    key: string;
    host: string;
    port: number;
    label: string;
    timerId?: number;
  } | null = null;
  private rhCredsByEndpoint = new Map<string, { user: string; pass: string }>();
  private rhBusy = false;
  private rhScanning = false;
  private rhScannedSubnet = "";
  private rhDiscovered: RHDiscoveredDevice[] = [];
  private rhError: string | null = null;
  private lastRhConnSig = "";
  private lastRhTimersStructSig = "";

  private rhUsbPorts: RHUSBPortInfo[] = [];
  private rhUsbSelectedPort = "";
  private rhUsbBaudRate = 0;
  private rhUsbShowAllPorts = false;
  private rhUsbRefreshing = false;
  private rhUsbLoadedOnce = false;
  private lastRhUsbConnSig = "";
  private lastRhUsbTimersStructSig = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    this.console = usbPool.primaryConsole();
    this.loadPrefs();
    if (this.console.connected && this.console.lastStatus) {
      this.status = this.console.lastStatus;
    }

    el.innerHTML = `
      <div class="settings debug-page network-page">
        <div data-slot="slaprf-sections" style="display:contents">
          <section class="settings-section" data-section-anchor="connection">
            <div class="settings-intro">
              <h2>Connection</h2>
              <p>Connect the Hub (or a Spoke) over USB-C to inspect the 2.4 GHz network and 5.8 GHz channel readings.</p>
            </div>
            <div class="debug-status-layout" data-slot="connection"></div>
          </section>

          <section class="settings-section" data-section-anchor="topology">
            <div class="settings-intro">
              <h2>Topology</h2>
              <p class="net-topo-intro-desktop">Parent Hub (Slot 1) in the center with 6 Spoke slots (Slots 2–7) around it. Active ESP-NOW links are solid; open or inactive slots are dashed. Click any slot to inspect it below.</p>
              <p class="net-topo-intro-mobile">Hub (Slot 1) and connected Spokes over 2.4 GHz ESP-NOW. Tap the Hub or any Spoke node in the graph to inspect it below.</p>
            </div>
            <div class="debug-status-layout" data-slot="topology"></div>
          </section>

          <section class="settings-section" data-section-anchor="timer">
            <div class="settings-intro">
              <h2>Timer</h2>
              <p>Identity, 2.4 GHz TDMA link stats, and live 5.8 GHz channel readings for the selected slot.</p>
            </div>
            <div class="debug-status-layout" data-slot="timer-detail"></div>
          </section>
        </div>

        <div data-slot="laprf-sections" style="display:none">
          <section class="settings-section" data-section-anchor="connection">
            <div class="settings-intro">
              <h2>Manual connection</h2>
              <p>Connect directly to a LapRF 8-Way timer by Ethernet IP (TCP :5403) or over a USB CDC serial link (115200 baud).</p>
            </div>
            <div class="debug-status-layout" data-slot="laprf-connection"></div>
          </section>

          <section class="settings-section" data-section-anchor="discover">
            <div class="settings-intro">
              <h2>Discover</h2>
              <p>Scan the local network for powered-on LapRF 8-Way timers on TCP :5403.</p>
            </div>
            <div class="debug-status-layout" data-slot="laprf-discover"></div>
          </section>

          <section class="settings-section" data-section-anchor="timer">
            <div class="settings-intro">
              <h2>LapRF timers</h2>
              <p>Live 8-slot RSSI readings (300–3500 scale), gate arming state, clock sync, and measured supply voltage for each LapRF 8-Way timer.</p>
            </div>
            <div class="debug-status-layout" data-slot="laprf-timers"></div>
          </section>
        </div>

        <div data-slot="rh-sections" style="display:none">
          <section class="settings-section" data-section-anchor="connection">
            <div class="settings-intro">
              <h2>Manual connection</h2>
              <p>Enter a RotorHazard server's IP address and port to sign in with admin credentials and connect directly.</p>
            </div>
            <div class="debug-status-layout" data-slot="rh-connection"></div>
          </section>

          <section class="settings-section" data-section-anchor="discover">
            <div class="settings-intro">
              <h2>Discover</h2>
              <p>Scan the local network for powered-on RotorHazard timing servers (HTTP/WebSocket :5000) and connect to discovered devices.</p>
            </div>
            <div class="debug-status-layout" data-slot="rh-discover"></div>
          </section>

          <section class="settings-section" data-section-anchor="timer">
            <div class="settings-intro">
              <h2>RotorHazard devices</h2>
              <p>Live receiver node RSSI readings (0–255 scale), dual Enter/Exit hysteresis thresholds, gate arming state, and clock sync for each RotorHazard device.</p>
            </div>
            <div class="debug-status-layout" data-slot="rh-timers"></div>
          </section>
        </div>

        <div data-slot="rh-usb-sections" style="display:none">
          <section class="settings-section" data-section-anchor="connection">
            <div class="settings-intro">
              <h2>USB serial connection</h2>
              <p>Connect RotorHazard USB serial nodes directly over USB-C / CDC (ESP32-C5, STM32, Arduino, or RP2040 binary serial protocol).</p>
            </div>
            <div class="debug-status-layout" data-slot="rh-usb-connection"></div>
          </section>

          <section class="settings-section" data-section-anchor="timer">
            <div class="settings-intro">
              <h2>RotorHazard USB devices</h2>
              <p>Live receiver node RSSI readings (0-255 scale), dual Enter/Exit hysteresis thresholds, gate arming state, and serial RTT for each RotorHazard USB device.</p>
            </div>
            <div class="debug-status-layout" data-slot="rh-usb-timers"></div>
          </section>
        </div>
      </div>`;

    const unsubMain = this.console.subscribe({
      onConnect: () => {
        this.status = this.activeStatus();
        this.renderAll();
      },
      onStatus: (s) => {
        this.status = this.activeStatus();
        if (
          s.role === 1 &&
          s.freqsTemporary &&
          !this.surveyAllRaceband &&
          !this.didResetTempHubChannels &&
          capabilitiesSnapshot().portable &&
          !this.store.simulatorRunning
        ) {
          this.didResetTempHubChannels = true;
          void usbPool.hubConsole()?.send("CHANNELS RESET").catch(() => undefined);
        }
        this.renderAll();
      },
      onLive: (l) => {
        this.live = l;
        this.liveAtMs = Date.now();
        if (this.selectedSlot === 1 || (this.status?.role === 2 && this.selectedSlot === this.status.slot)) {
          this.scheduleLiveRefresh();
        }
      },
      onHubPackets: () => {
        this.scheduleLiveRefresh();
      },
      onHubLive: () => {
        this.scheduleLiveRefresh();
      },
      onConfig: () => {
        this.renderAll();
      },
      onDisconnect: () => {
        this.status = this.activeStatus();
        if (!this.status) {
          this.live = null;
          this.userPickedSlot = false;
          this.selectedSlot = 1;
          this.signalEnabledCh = [true, true, true, true, true, true, true, true];
          this.spokeRateTracker.clear();
          this.identifyPending.clear();
        }
        this.renderAll();
      },
    });

    const unsubState = usbPool.onChange(() => {
      this.status = this.activeStatus();
      this.renderAll();
    });

    const unsubBridge = this.api.hubBridge.subscribe(() => {
      this.scheduleLiveRefresh();
    });

    const unsubStore = this.store.subscribe(["status", "config", "telemetry"], () => {
      if (this.surveyAllRaceband && this.isLiveRaceHeatActive()) {
        void this.setSurveyMode(false);
        return;
      }
      this.scheduleLiveRefresh();
    });

    const unsubLaprf = sharedLapRFLink.subscribe(() => {
      this.scheduleLiveRefresh();
    });

    const unsubRh = sharedRHLink.subscribe(() => {
      this.scheduleLiveRefresh();
    });

    this.livePollTimer = window.setInterval(() => {
      if (document.hidden) return;
      this.livePollTick++;
      const hwMode = this.store.timingHardwareMode;
      if (isSlapRFMode(hwMode)) {
        if (this.store.simulatorRunning) {
          this.scheduleLiveRefresh();
        } else {
          const s = this.activeStatus();
          if (
            s &&
            s.role === 2 &&
            !s.scanLive &&
            !s.emergencyMode &&
            this.livePollTick % 2 === 0 &&
            !this.livePollInFlight
          ) {
            this.livePollInFlight = true;
            void usbPool.mainConsole
              .send("STATUS?")
              .catch(() => undefined)
              .finally(() => {
                this.livePollInFlight = false;
              });
          }
          this.scheduleLiveRefresh();
        }
        return;
      }
      if (hwMode === "laprf" || isRotorHazardMode(hwMode)) {
        if (this.store.simulatorRunning) {
          if (!this.livePollInFlight) {
            this.livePollInFlight = true;
            void this.api
              .pollStatusNow()
              .catch(() => undefined)
              .finally(() => {
                this.livePollInFlight = false;
                this.scheduleLiveRefresh();
              });
          }
        } else {
          if (this.livePollTick % 2 === 0) {
            if (hwMode === "laprf") {
              void sharedLapRFLink.refreshStatus();
            } else {
              void sharedRHLink.refreshStatus();
            }
          }
          this.scheduleLiveRefresh();
        }
      }
    }, 55);

    let touchSlotTap: {
      pointerId: number;
      startX: number;
      startY: number;
      slotNum?: number;
      identifyFp?: string;
      identifyWant?: boolean;
    } | null = null;

    this.listen(el, "pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      const idBtn = (pe.target as HTMLElement).closest<HTMLButtonElement>('[data-action="toggle-identify"]');
      const slotBtn = idBtn
        ? null
        : (pe.target as HTMLElement).closest<HTMLElement>('[data-action="select-topology-slot"]');
      if (!idBtn && !slotBtn) return;

      // On touch/pen screens, defer selection until pointerup so vertical scroll drags never accidentally select a slot.
      if (pe.pointerType !== "mouse") {
        touchSlotTap = {
          pointerId: pe.pointerId,
          startX: pe.clientX,
          startY: pe.clientY,
          slotNum: slotBtn ? Number(slotBtn.dataset.slotNum) : undefined,
          identifyFp: idBtn && !idBtn.disabled ? idBtn.dataset.fp || "" : undefined,
          identifyWant: idBtn && !idBtn.disabled ? idBtn.dataset.on !== "1" : undefined,
        };
        return;
      }

      if (idBtn) {
        if (!idBtn.disabled) void this.toggleIdentify(idBtn.dataset.fp || "", idBtn.dataset.on !== "1");
        return;
      }
      if (slotBtn) {
        this.selectTopologySlot(Number(slotBtn.dataset.slotNum));
      }
    });
    this.listen(el, "pointermove", (e) => {
      const pe = e as PointerEvent;
      if (touchSlotTap && pe.pointerId === touchSlotTap.pointerId) {
        if (Math.hypot(pe.clientX - touchSlotTap.startX, pe.clientY - touchSlotTap.startY) > 10) {
          touchSlotTap = null;
        }
      }
    });
    this.listen(el, "pointercancel", () => {
      touchSlotTap = null;
    });
    this.listen(el, "pointerup", (e) => {
      const pe = e as PointerEvent;
      if (!touchSlotTap || pe.pointerId !== touchSlotTap.pointerId) return;
      const pending = touchSlotTap;
      touchSlotTap = null;
      if (Math.hypot(pe.clientX - pending.startX, pe.clientY - pending.startY) > 10) return;
      if (pending.identifyFp !== undefined && pending.identifyWant !== undefined) {
        void this.toggleIdentify(pending.identifyFp, pending.identifyWant);
      } else if (pending.slotNum !== undefined && Number.isFinite(pending.slotNum)) {
        this.selectTopologySlot(pending.slotNum);
      }
    });
    this.listen(el, "click", (e) => void this.onClick(e));
    this.listen(el, "dblclick", (e) => this.onDblClick(e));
    this.listen(el, "input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.field === "laprf-host") {
        this.laprfHost = t.value;
      } else if (t.dataset.field === "laprf-port") {
        const p = Number(t.value);
        if (Number.isFinite(p) && p > 0) this.laprfPort = p;
      } else if (t.dataset.field === "rh-host") {
        this.rhHost = t.value;
      } else if (t.dataset.field === "rh-port") {
        const p = Number(t.value);
        if (Number.isFinite(p) && p > 0) this.rhPort = p;
      } else if (t.dataset.field === "rh-cred-user") {
        this.rhUser = t.value;
      } else if (t.dataset.field === "rh-cred-pass") {
        this.rhPass = t.value;
      }
    });
    this.listen(el, "keydown", (e) => {
      const ke = e as KeyboardEvent;
      const rowBtn = (ke.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="net-signal-ch"]');
      if (rowBtn && (ke.key === "Enter" || ke.key === " ")) {
        ke.preventDefault();
        this.toggleSignalCh(Number(rowBtn.dataset.ch));
        return;
      }
      const t = ke.target as HTMLInputElement | null;
      if (
        ke.key === "Enter" &&
        t &&
        (t.dataset.field === "rh-cred-user" || t.dataset.field === "rh-cred-pass")
      ) {
        ke.preventDefault();
        void this.submitRhCredPrompt();
      } else if (
        ke.key === "Escape" &&
        this.rhCredPrompt &&
        t &&
        (t.dataset.field === "rh-cred-user" || t.dataset.field === "rh-cred-pass")
      ) {
        ke.preventDefault();
        this.rhCredPrompt = null;
        this.lastRhConnSig = "";
        this.lastRhTimersStructSig = "";
        this.renderAll();
      }
    });
    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement;
      if (t.matches("[data-all-ports]")) {
        this.showAllPorts = (t as HTMLInputElement).checked;
        this.savePrefs();
      } else if (t.dataset.field === "rh-usb-port") {
        this.rhUsbSelectedPort = t.value;
        this.lastRhUsbConnSig = "";
        this.renderAll();
      } else if (t.dataset.field === "rh-usb-baud") {
        const b = Number(t.value);
        this.rhUsbBaudRate = Number.isFinite(b) && b > 0 ? b : 0;
        this.lastRhUsbConnSig = "";
        this.renderAll();
      } else if (t.dataset.field === "rh-usb-all-ports") {
        this.rhUsbShowAllPorts = (t as HTMLInputElement).checked;
        void this.refreshRhUsbPorts();
      }
    });

    const unsubTheme = subscribeAppTheme(() => {
      this.lastTopologyHtml = "";
      this.lastTopologyStructKey = "";
      this.lastTimerHtml = "";
      this.lastTimerStructKey = "";
      this.lastLaprfConnSig = "";
      this.lastLaprfTimersStructSig = "";
      this.lastRhConnSig = "";
      this.lastRhTimersStructSig = "";
      this.lastRhUsbConnSig = "";
      this.lastRhUsbTimersStructSig = "";
      this.renderAll();
    });

    const onBeforeUnload = () => {
      this.releaseSurveyOnLeave();
    };
    const onVisibilityChange = () => {
      if (document.hidden && this.surveyAllRaceband) {
        this.releaseSurveyOnLeave();
        this.renderAll();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);

    this.onDispose(() => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      this.releaseSurveyOnLeave();
      if (this.rafId !== 0) {
        window.cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      if (this.livePollTimer !== null) {
        window.clearInterval(this.livePollTimer);
        this.livePollTimer = null;
      }
      unsubMain();
      unsubState();
      unsubBridge();
      unsubStore();
      unsubLaprf();
      unsubRh();
      unsubTheme();
    });

    void this.syncInitialSurveyState();
    this.renderAll();
  }

  public override onActivate(): void {
    this.isViewActive = true;
    void this.syncInitialSurveyState();
    this.renderAll();
  }

  public override onDeactivate(): void {
    this.isViewActive = false;
    if (this.surveyAllRaceband) {
      this.releaseSurveyOnLeave();
      this.renderAll();
    } else {
      this.stopSurveyLeaseTimer();
    }
  }

  private slot(name: string): HTMLElement {
    return this.el.querySelector<HTMLElement>(`[data-slot="${name}"]`)!;
  }

  private loadPrefs(): void {
    try {
      const raw = window.localStorage.getItem(NETWORK_PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Record<string, unknown>;
      if (typeof p.showAllPorts === "boolean") {
        this.showAllPorts = p.showAllPorts;
      }
      if (Array.isArray(p.signalEnabledCh) && p.signalEnabledCh.length === 8) {
        this.signalEnabledCh = p.signalEnabledCh.map(Boolean);
      }
    } catch {
      // ignore
    }
  }

  private savePrefs(): void {
    try {
      window.localStorage.setItem(
        NETWORK_PREFS_KEY,
        JSON.stringify({
          showAllPorts: this.showAllPorts,
          signalEnabledCh: this.signalEnabledCh,
        })
      );
    } catch {
      // ignore
    }
  }

  /**
   * The last `LIVE` sample, only while the stream is still running. The Debug page (or its
   * self-test) turns `LIVE` on and off; a stale sample must not freeze the bars after it stops.
   */
  private freshLive(): LiveSample | null {
    return this.live && Date.now() - this.liveAtMs < 1000 ? this.live : null;
  }

  private isLiveRaceHeatActive(): boolean {
    const r = this.store.raceState;
    if (
      !r?.generated ||
      r.emergencyStopped ||
      r.lifecycle === "paused" ||
      r.lifecycle === "completed" ||
      r.lifecycle === "scrapped"
    ) {
      return false;
    }
    return Boolean(r.heats?.some((h) => h.state === "countdown" || h.state === "running"));
  }

  /**
   * Mirrors `tracker.ComputeActivePilotChannels`: maps enabled pilots onto the 8 hardware slots
   * (0 = disabled slot) and collects pilot callsigns per slot and per frequency.
   */
  private computeCourseChannelTable(): {
    slotMhz: number[];
    mhzPilots: Map<number, string[]>;
  } {
    const slotMhz = [0, 0, 0, 0, 0, 0, 0, 0];
    const mhzPilots = new Map<number, string[]>();
    const pilots = this.store.pilots ?? [];
    for (const p of pilots) {
      if (!p.enabled || p.frequencyMhz < 5180) continue;
      const list = mhzPilots.get(p.frequencyMhz) ?? [];
      if (p.callsign && !list.includes(p.callsign)) list.push(p.callsign);
      mhzPilots.set(p.frequencyMhz, list);
    }
    for (let ch = 0; ch < 8; ch++) {
      const p = pilots[ch];
      if (p && p.enabled && p.frequencyMhz >= 5180) {
        slotMhz[ch] = p.frequencyMhz;
      }
    }
    for (let i = 8; i < pilots.length; i++) {
      const p = pilots[i];
      if (!p?.enabled || p.frequencyMhz < 5180) continue;
      for (let ch = 0; ch < 8; ch++) {
        if (slotMhz[ch] === 0) {
          slotMhz[ch] = p.frequencyMhz;
          break;
        }
      }
    }
    return { slotMhz, mhzPilots };
  }

  /** Visible channel rows for the RSSI inspector in Pilot-channels mode vs All-Raceband survey mode. */
  private visibleBarSpecs(): Array<{ idx: number; mhz: number; pilot: string }> {
    const { slotMhz, mhzPilots } = this.computeCourseChannelTable();
    if (this.surveyAllRaceband) {
      return RACEBAND.map((mhz, idx) => ({
        idx,
        mhz,
        pilot: (mhzPilots.get(mhz) ?? []).join(", "),
      }));
    }
    const out: Array<{ idx: number; mhz: number; pilot: string }> = [];
    const seenMhz = new Set<number>();
    for (let ch = 0; ch < 8; ch++) {
      const mhz = slotMhz[ch];
      if (mhz < 5180 || seenMhz.has(mhz)) continue;
      seenMhz.add(mhz);
      out.push({
        idx: ch,
        mhz,
        pilot: (mhzPilots.get(mhz) ?? []).join(", "),
      });
    }
    return out;
  }

  private toggleSignalCh(idx: number): void {
    if (idx < 0 || idx >= 8) return;
    this.signalEnabledCh[idx] = !this.signalEnabledCh[idx];
    this.savePrefs();
    this.renderAll();
  }

  private onDblClick(e: Event): void {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="net-signal-ch"]');
    if (!btn) return;
    const idx = Number(btn.dataset.ch);
    if (idx < 0 || idx >= 8) return;
    const visible = this.visibleBarSpecs().map((b) => b.idx);
    const enabledVisible = visible.filter((i) => this.signalEnabledCh[i]);
    const isSolo = this.signalEnabledCh[idx] && enabledVisible.length === 1;
    this.signalEnabledCh = this.signalEnabledCh.map((_, i) => (isSolo ? true : i === idx));
    this.savePrefs();
    this.renderAll();
  }

  private stopSurveyLeaseTimer(): void {
    if (this.surveyLeaseTimer !== null) {
      window.clearInterval(this.surveyLeaseTimer);
      this.surveyLeaseTimer = null;
    }
  }

  private startSurveyLeaseTimer(): void {
    this.stopSurveyLeaseTimer();
    this.surveyLeaseTimer = window.setInterval(() => {
      if (!this.surveyAllRaceband) {
        this.stopSurveyLeaseTimer();
        return;
      }
      if (!this.isViewActive || this.el.hidden || document.hidden || this.isLiveRaceHeatActive()) {
        this.releaseSurveyOnLeave();
        this.renderAll();
        return;
      }
      if (capabilitiesSnapshot().portable && !this.store.simulatorRunning) {
        void fetch(resolveBackendUrl("/api/hub/survey"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ on: true }),
        })
          .then(async (r) => {
            if (!r.ok) {
              this.surveyAllRaceband = false;
              this.stopSurveyLeaseTimer();
              this.renderAll();
            }
          })
          .catch(() => undefined);
      }
    }, 5000);
  }

  private async syncInitialSurveyState(): Promise<void> {
    if (!capabilitiesSnapshot().portable || this.store.simulatorRunning || !isSlapRFMode(this.store.timingHardwareMode)) {
      return;
    }
    try {
      const resp = await fetch(resolveBackendUrl("/api/hub/survey"));
      if (!resp.ok) return;
      const data = (await resp.json()) as { active?: boolean };
      this.surveyAllRaceband = Boolean(data.active);
      if (this.surveyAllRaceband) {
        this.startSurveyLeaseTimer();
      } else if (usbPool.hubConsole()?.lastStatus?.freqsTemporary && !this.didResetTempHubChannels) {
        this.didResetTempHubChannels = true;
        void usbPool.hubConsole()?.send("CHANNELS RESET").catch(() => undefined);
      }
      this.renderAll();
    } catch {
      // ignore
    }
  }

  private async setSurveyMode(want: boolean): Promise<void> {
    this.surveyError = null;
    if (want && this.isLiveRaceHeatActive()) {
      this.surveyError = "Cannot measure all Raceband while a race heat is running.";
      this.renderAll();
      return;
    }
    this.surveyAllRaceband = want;
    if (want) {
      this.startSurveyLeaseTimer();
    } else {
      this.stopSurveyLeaseTimer();
    }
    if (capabilitiesSnapshot().portable && !this.store.simulatorRunning) {
      try {
        const resp = await fetch(resolveBackendUrl("/api/hub/survey"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ on: want }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          this.surveyAllRaceband = false;
          this.stopSurveyLeaseTimer();
          this.surveyError = body.error || "Could not switch channel survey mode.";
        }
      } catch {
        this.surveyAllRaceband = false;
        this.stopSurveyLeaseTimer();
        this.surveyError = "Could not reach SlapRF Server.";
      }
    } else if (this.store.simulatorRunning) {
      const hub = usbPool.hubConsole() ?? sharedTimerConsole;
      if (hub.connected) {
        const freqs = want ? RACEBAND : this.computeCourseChannelTable().slotMhz;
        void hub.send(`NETCHANNELS ${freqs.join(",")}`).catch(() => undefined);
      }
    }
    this.renderAll();
  }

  private releaseSurveyOnLeave(): void {
    this.stopSurveyLeaseTimer();
    if (!this.surveyAllRaceband) return;
    this.surveyAllRaceband = false;
    if (capabilitiesSnapshot().portable && !this.store.simulatorRunning) {
      void fetch(resolveBackendUrl("/api/hub/survey"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: false }),
        keepalive: true,
      }).catch(() => undefined);
    } else if (this.store.simulatorRunning) {
      const hub = usbPool.hubConsole() ?? sharedTimerConsole;
      if (hub.connected) {
        const freqs = this.computeCourseChannelTable().slotMhz;
        void hub.send(`NETCHANNELS ${freqs.join(",")}`).catch(() => undefined);
      }
    }
  }

  private activeStatus(): TimerStatus | null {
    const primary = usbPool.mainConsole;
    if (primary.connected && primary.lastStatus) {
      return primary.lastStatus;
    }
    return null;
  }

  private scheduleLiveRefresh(): void {
    if (this.rafId !== 0) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      this.renderAll();
    });
  }

  /**
   * In Simulator mode (`store.simState.running`), maps pilot-slot-indexed RSSI from the 50 Hz
   * WASM simulator onto the 8 monitored channel frequencies (`freqs`, e.g. R1..R8).
   * Returns `undefined` in real-hardware mode so real timers use genuine hardware `dbm` frames.
   */
  private mapSimPilotRssiToFreqs(
    timerId: number | undefined,
    fallbackRssi: number[] | undefined,
    baseFloorDbm: number | undefined,
    freqs: number[]
  ): number[] | undefined {
    if (!this.store.simulatorRunning) return undefined;
    const liveWasm = timerId !== undefined ? window.slaprfWasm?.getSimTimerRssi?.(timerId) : null;
    const assignedNode =
      timerId !== undefined
        ? this.store.nodes.find((n) => (n.assignedTimerId ?? n.gateId) === timerId)
        : undefined;
    const assignedHist = assignedNode ? this.store.historyFor(assignedNode.gateId) : [];
    const liveNodeRssi =
      assignedHist.length > 0
        ? assignedHist[assignedHist.length - 1].rssi
        : assignedNode && Array.isArray(assignedNode.lastRssi) && assignedNode.lastRssi.some((v) => v < 0)
          ? assignedNode.lastRssi
          : undefined;
    const simTimer =
      timerId !== undefined
        ? this.store.simState?.timers?.find((t) => t.timerId === timerId)
        : undefined;
    const baseFloor = Math.round(baseFloorDbm || -92);
    // Prefer 50 Hz WebSocket node telemetry over 0.5 Hz (/api/status) simState.timers snapshots!
    let rawRssi: number[] | undefined =
      Array.isArray(liveWasm) && liveWasm.some((v) => v < 0)
        ? liveWasm
        : Array.isArray(liveNodeRssi) && liveNodeRssi.some((v) => v < 0)
          ? liveNodeRssi
          : assignedNode && Array.isArray(fallbackRssi) && fallbackRssi.some((v) => v < 0)
            ? fallbackRssi
            : undefined;
    if (!rawRssi && this.store.nodes.length > 0) {
      // Off-track collector Hub sits near the Start/Finish table: derive live 50 Hz RSSI from Start gate
      const startNode = this.store.nodes[0];
      const hist = this.store.historyFor(startNode.gateId);
      const srcRssi =
        hist.length > 0
          ? hist[hist.length - 1].rssi
          : Array.isArray(startNode.lastRssi) && startNode.lastRssi.some((v) => v < 0)
            ? startNode.lastRssi
            : undefined;
      if (srcRssi) {
        rawRssi = srcRssi.map((v) => Math.max(baseFloor, v - 3.5 + (Math.random() - 0.5) * 1.0));
      }
    }
    if (!rawRssi) {
      rawRssi =
        Array.isArray(simTimer?.lastRssi) && simTimer!.lastRssi.some((v) => v < 0)
          ? simTimer!.lastRssi
          : Array.isArray(fallbackRssi) && fallbackRssi.some((v) => v < 0)
            ? fallbackRssi
            : undefined;
    }

    const pilots = this.store.pilots ?? [];
    const roundHalf = (x: number) => Math.round(x * 2) / 2;
    const out: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (!this.signalEnabledCh[i]) {
        out.push(-128);
        continue;
      }
      const wantFreq = freqs[i] ?? 0;
      if (wantFreq < 5180) {
        out.push(-128);
        continue;
      }
      const floorVal = baseFloor - (i % 2) * 0.5;
      const matchIdx = pilots.findIndex(
        (p) => p.enabled && p.frequencyMhz > 0 && Math.abs(p.frequencyMhz - wantFreq) <= 8
      );
      let val: number;
      if (rawRssi && matchIdx >= 0 && matchIdx < rawRssi.length && rawRssi[matchIdx] < 0) {
        const detLoss = Math.abs(pilots[matchIdx].frequencyMhz - wantFreq) * 1.4;
        const jitter = (Math.random() - 0.5) * 0.6;
        val = roundHalf(Math.max(floorVal - 2, rawRssi[matchIdx] - detLoss + jitter));
      } else {
        val = roundHalf(floorVal + (Math.random() - 0.5) * 1.6);
      }
      out.push(Math.max(-120, Math.min(-15, val)));
    }
    return out;
  }

  /** True/false = identify state of `fp` as reported by the USB-connected board; null = not reachable. */
  private identifyActual(fp: string): boolean | null {
    const direct = usbPool.findByFingerprint(fp);
    if (direct && direct.lastStatus && !direct.lastStatus.emergencyMode) {
      return Boolean(direct.lastStatus.identify);
    }
    const hub = usbPool.hubConsole();
    if (hub && hub.lastStatus && !hub.lastStatus.emergencyMode) {
      if ((hub.lastStatus.fp || "").toUpperCase() === fp) return Boolean(hub.lastStatus.identify);
      return (hub.lastStatus.identifyFp || "").toUpperCase() === fp;
    }
    return null;
  }

  private async toggleIdentify(fp: string, on: boolean): Promise<void> {
    const FP = fp.toUpperCase();
    if (!FP) return;
    this.identifyPending.set(FP, { on, atMs: Date.now() });
    this.renderAll();
    try {
      const target = usbPool.findByFingerprint(FP) ?? usbPool.hubConsole() ?? usbPool.primaryConsole();
      await target.setIdentify(FP, on);
    } catch {
      this.identifyPending.delete(FP); // Old firmware ("unknown command") or disconnected
      this.renderAll();
    }
  }

  /**
   * Identify toggle for timer `fp`. Shown only when the USB-connected board can reach it (the board
   * itself, or a Spoke of the connected Hub). Turning on needs a live link; turning off always works.
   */
  private renderIdentifyButton(fp: string, linked: boolean, label: string): string {
    const FP = (fp || "").toUpperCase();
    if (!/^[0-9A-F]{8}$/.test(FP) || FP.startsWith("53504B")) return "";
    const actual = this.identifyActual(FP);
    if (actual === null) return "";
    let on = actual;
    const pending = this.identifyPending.get(FP);
    if (pending) {
      if (pending.on === actual || Date.now() - pending.atMs > 4000) {
        this.identifyPending.delete(FP);
      } else {
        on = pending.on;
      }
    }
    const enabled = on || linked;
    const title = on
      ? `${label}'s LED is strobing (3 quick flashes, pause). Click to stop.`
      : linked
        ? `Strobe ${label}'s LED (3 quick flashes, pause) until you switch it off, to find which board it is`
        : `${label} isn't linked right now`;
    return `
      <button type="button" class="btn btn-sm ${on ? "btn-armed" : "btn-unarmed"}" style="min-width:106px;justify-content:center" data-action="toggle-identify" data-fp="${FP}" data-on="${on ? 1 : 0}" aria-pressed="${on}" ${enabled ? "" : "disabled"} title="${esc(title)}">
        ${icons.target(14)}<span>${on ? "Identifying" : "Identify"}</span>
      </button>`;
  }

  private selectTopologySlot(slotNum: number): void {
    if (slotNum >= 1 && slotNum <= 7) {
      this.selectedSlot = slotNum;
      this.userPickedSlot = true;
      this.renderAll();
      this.savePrefs();
    }
  }

  private async onClick(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    switch (t.dataset.action) {
      case "select-topology-slot":
        this.selectTopologySlot(Number(t.dataset.slotNum));
        break;
      case "net-signal-ch":
        this.toggleSignalCh(Number(t.dataset.ch));
        break;
      case "set-channel-scope": {
        const wantSurvey = t.dataset.scope === "raceband";
        if (wantSurvey !== this.surveyAllRaceband) {
          await this.setSurveyMode(wantSurvey);
        }
        break;
      }
      case "select-usb-slot": {
        const s = usbPool.mainConsole.lastStatus;
        if (s?.role === 1) {
          this.selectTopologySlot(1);
        } else if (s?.role === 2 && s.slot >= 2 && s.slot <= 7) {
          this.selectTopologySlot(s.slot);
        } else {
          this.renderAll();
        }
        break;
      }
      case "disconnect-usb-slot": {
        this.connError = null;
        await usbPool.mainConsole.disconnectCleanly();
        break;
      }
      case "connect-add": {
        this.connError = null;
        try {
          const isBle = this.store.timingHardwareMode === "slaprf_ble";
          const c = await usbPool.connectMain(isBle ? false : this.showAllPorts);
          const s = c.status;
          if (s?.role === 1) {
            this.selectTopologySlot(1);
          } else if (s?.role === 2 && s.slot >= 2 && s.slot <= 7) {
            this.selectTopologySlot(s.slot);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/No port selected|aborted|cancelled|cancel/i.test(msg)) {
            this.connError = msg;
          }
        }
        this.renderAll();
        break;
      }
      case "laprf-connect-eth": {
        if (this.laprfBusy) break;
        this.laprfBusy = true;
        this.laprfError = null;
        this.lastLaprfConnSig = "";
        this.renderAll();
        try {
          await sharedLapRFLink.connectEthernet(
            this.store,
            this.api,
            this.laprfHost,
            this.laprfPort
          );
          if (this.laprfDiscovered.length > 0) {
            const res = await sharedLapRFLink.discover(this.store, this.api).catch(() => null);
            if (res) {
              this.laprfScannedSubnet = res.subnet;
              this.laprfDiscovered = res.devices;
            }
          }
        } catch (err) {
          this.laprfError = err instanceof Error ? err.message : String(err);
        } finally {
          this.laprfBusy = false;
          this.lastLaprfConnSig = "";
          this.lastLaprfTimersStructSig = "";
          this.renderAll();
        }
        break;
      }
      case "laprf-connect-discovered": {
        if (this.laprfBusy) break;
        const host = t.dataset.host || "192.168.1.2";
        const port = Number(t.dataset.port) || 5403;
        const label = t.dataset.label || "";
        this.laprfBusy = true;
        this.laprfError = null;
        this.lastLaprfConnSig = "";
        this.renderAll();
        try {
          await sharedLapRFLink.connectEthernet(this.store, this.api, host, port, label);
          const res = await sharedLapRFLink.discover(this.store, this.api).catch(() => null);
          if (res) {
            this.laprfScannedSubnet = res.subnet;
            this.laprfDiscovered = res.devices;
          }
        } catch (err) {
          this.laprfError = err instanceof Error ? err.message : String(err);
        } finally {
          this.laprfBusy = false;
          this.lastLaprfConnSig = "";
          this.lastLaprfTimersStructSig = "";
          this.renderAll();
        }
        break;
      }
      case "laprf-scan-lan": {
        if (this.laprfScanning) break;
        this.laprfScanning = true;
        this.laprfError = null;
        this.lastLaprfConnSig = "";
        this.renderAll();
        try {
          const res = await sharedLapRFLink.discover(this.store, this.api);
          this.laprfScannedSubnet = res.subnet;
          this.laprfDiscovered = res.devices;
        } catch (err) {
          this.laprfError = err instanceof Error ? err.message : String(err);
        } finally {
          this.laprfScanning = false;
          this.lastLaprfConnSig = "";
          this.renderAll();
        }
        break;
      }
      case "laprf-connect-usb": {
        if (this.laprfBusy) break;
        this.laprfBusy = true;
        this.laprfError = null;
        this.lastLaprfConnSig = "";
        this.renderAll();
        try {
          await sharedLapRFLink.connectUsb(this.store, this.api);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/No port selected|aborted|cancelled|cancel/i.test(msg)) {
            this.laprfError = msg;
          }
        } finally {
          this.laprfBusy = false;
          this.lastLaprfConnSig = "";
          this.lastLaprfTimersStructSig = "";
          this.renderAll();
        }
        break;
      }
      case "laprf-disconnect": {
        const timerId = Number(t.dataset.timerId);
        if (Number.isFinite(timerId)) {
          this.laprfError = null;
          await sharedLapRFLink.disconnect(this.store, this.api, timerId).catch(() => undefined);
          if (this.laprfDiscovered.length > 0) {
            const res = await sharedLapRFLink.discover(this.store, this.api).catch(() => null);
            if (res) {
              this.laprfScannedSubnet = res.subnet;
              this.laprfDiscovered = res.devices;
            }
          }
          this.lastLaprfConnSig = "";
          this.lastLaprfTimersStructSig = "";
          this.renderAll();
        }
        break;
      }
      case "rh-toggle-pass": {
        this.rhRevealPass = !this.rhRevealPass;
        const inp = this.el.querySelector<HTMLInputElement>('input[data-field="rh-cred-pass"]');
        if (inp) {
          inp.type = this.rhRevealPass ? "text" : "password";
        }
        const label = this.rhRevealPass ? "Hide admin password" : "Reveal admin password";
        t.setAttribute("aria-label", label);
        t.title = label;
        t.innerHTML = this.rhRevealPass ? icons.eyeOff(15) : icons.eye(15);
        this.lastRhConnSig = "";
        this.lastRhTimersStructSig = "";
        break;
      }
      case "rh-open-manual-creds": {
        const host = this.rhHost.trim() || "192.168.1.101";
        const port = this.rhPort || DEFAULT_RH_PORT;
        this.openRhCredPrompt({
          scope: "manual",
          key: `manual:${host}:${port}`,
          host,
          port,
          label: `${host}:${port}`,
        });
        break;
      }
      case "rh-open-device-creds": {
        const host = t.dataset.host || "192.168.1.101";
        const port = Number(t.dataset.port) || DEFAULT_RH_PORT;
        const label = t.dataset.label || `${host}:${port}`;
        const timerId = Number(t.dataset.timerId) || undefined;
        const scope = t.dataset.credScope === "card" ? "card" : "discovered";
        this.openRhCredPrompt({
          scope,
          key: `${scope}:${timerId ?? ""}:${host}:${port}`,
          host,
          port,
          label,
          timerId,
        });
        break;
      }
      case "rh-cred-cancel": {
        this.rhCredPrompt = null;
        this.rhError = null;
        this.lastRhConnSig = "";
        this.lastRhTimersStructSig = "";
        this.renderAll();
        break;
      }
      case "rh-cred-submit": {
        await this.submitRhCredPrompt();
        break;
      }
      case "rh-scan-lan": {
        if (this.rhScanning) break;
        this.rhScanning = true;
        this.rhError = null;
        this.lastRhConnSig = "";
        this.renderAll();
        try {
          const res = await sharedRHLink.scanLan(this.store, this.api, this.rhPort);
          this.rhScannedSubnet = res.subnet;
          this.rhDiscovered = res.devices;
        } catch (err) {
          this.rhError = err instanceof Error ? err.message : String(err);
        } finally {
          this.rhScanning = false;
          this.lastRhConnSig = "";
          this.renderAll();
        }
        break;
      }
      case "rh-usb-refresh": {
        await this.refreshRhUsbPorts();
        break;
      }
      case "rh-usb-connect": {
        if (this.rhBusy) break;
        const portFromBtn = t.dataset.portName?.trim() || "";
        const portToUse = portFromBtn || this.rhUsbSelectedPort.trim();
        if (!portToUse) {
          this.rhError = "Select a USB serial port to connect.";
          this.lastRhUsbConnSig = "";
          this.renderAll();
          break;
        }
        this.rhBusy = true;
        this.rhError = null;
        this.lastRhUsbConnSig = "";
        this.lastRhUsbTimersStructSig = "";
        this.renderAll();
        try {
          await sharedRHLink.connectUSBDevice(this.store, this.api, {
            portName: portToUse,
            baudRate: this.rhUsbBaudRate || undefined,
            preferredLabel: t.dataset.label || undefined,
            preferredTimerId: Number(t.dataset.timerId) || undefined,
          });
          if (!this.store.simulatorRunning) {
            await this.refreshRhUsbPorts();
          }
        } catch (err) {
          this.rhError = err instanceof Error ? err.message : String(err);
        } finally {
          this.rhBusy = false;
          this.lastRhUsbConnSig = "";
          this.lastRhUsbTimersStructSig = "";
          this.renderAll();
        }
        break;
      }
      case "rh-disconnect": {
        const timerId = Number(t.dataset.timerId);
        if (Number.isFinite(timerId)) {
          this.rhError = null;
          await sharedRHLink.disconnectDevice(this.store, this.api, timerId).catch(() => undefined);
          if (this.rhDiscovered.length > 0 && this.store.timingHardwareMode === "rotorhazard") {
            const res = await sharedRHLink
              .scanLan(this.store, this.api, this.rhPort)
              .catch(() => null);
            if (res) {
              this.rhScannedSubnet = res.subnet;
              this.rhDiscovered = res.devices;
            }
          }
          if (!this.store.simulatorRunning && this.store.timingHardwareMode === "rotorhazard_usb") {
            await this.refreshRhUsbPorts();
          }
          this.lastRhConnSig = "";
          this.lastRhTimersStructSig = "";
          this.lastRhUsbConnSig = "";
          this.lastRhUsbTimersStructSig = "";
          this.renderAll();
        }
        break;
      }
    }
  }

  private buildTopologyState(): {
    hub: TopologyHubInfo;
    spokes: Map<number, TopologySpokeInfo>;
  } {
    const s = this.activeStatus();
    const hubConsole = usbPool.hubConsole();
    const hubUsbStatus = s && s.role === 1 ? s : hubConsole?.connected ? hubConsole.lastStatus : null;
    const activeHubConsole = hubConsole ?? sharedTimerConsole;
    const freqs = this.surveyAllRaceband ? [...RACEBAND] : this.computeCourseChannelTable().slotMhz;
    const detectedTimers: DetectedTimer[] = this.store.detectedTimers;
    const ch = hubUsbStatus?.channel || s?.channel || 1;
    const nowMs = performance.now();

    const formatTrackPos = (g: { trackOrder: number; role: string }) =>
      `Track #${g.trackOrder + 1}${g.role === "START_FINISH" ? " (Start)" : ""}`;

    const hubGate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === 1);
    const hubGateName = hubGate ? formatTrackPos(hubGate) : undefined;
    const hubServerTimer = detectedTimers.find((t) => t.isHub || t.timerId === 1);

    const isBleLink =
      this.store.timingHardwareMode === "slaprf_ble" || activeHubConsole.transportLabel === "Bluetooth";
    let hub: TopologyHubInfo;
    if (hubUsbStatus && hubUsbStatus.role === 1) {
      const rfActive = !hubUsbStatus.emergencyMode && hubUsbStatus.rf?.enabled !== false && !hubUsbStatus.scanLive;
      const hubSlotLive = activeHubConsole.hubSlotLive.get(1);
      const simDbm = rfActive
        ? this.mapSimPilotRssiToFreqs(
            hubServerTimer?.timerId ?? 1,
            hubGate?.lastRssi ?? hubServerTimer?.lastRssi,
            hubGate?.noiseFloorDbm ?? hubServerTimer?.noiseFloorDbm ?? hubUsbStatus.rf?.floorDb,
            freqs
          )
        : [-128, -128, -128, -128, -128, -128, -128, -128];
      const liveDbm =
        s && s.role === 1 && this.freshLive()?.dbm?.length === 8
          ? this.freshLive()!.dbm
          : simDbm?.length === 8
            ? simDbm
            : hubSlotLive?.dbm?.length === 8
              ? hubSlotLive.dbm
              : activeHubConsole.hubLastDbm?.length === 8
                ? activeHubConsole.hubLastDbm
                : hubUsbStatus.dbm?.length === 8
                  ? hubUsbStatus.dbm
                  : undefined;
      const hubFrames = Math.max(
        activeHubConsole.hubOwnFrames,
        hubGate?.framesRxCount ?? 0,
        hubServerTimer?.framesRxCount ?? 0
      );
      hub = {
        populated: true,
        online: !hubUsbStatus.emergencyMode,
        label: hubUsbStatus.label || hubServerTimer?.timerLabel || "H1",
        fp: hubUsbStatus.fp || "-",
        fw: hubUsbStatus.fw || "-",
        mac: hubUsbStatus.chip?.mac || "-",
        ch,
        viaUsb: true,
        emergencyMode: Boolean(hubUsbStatus.emergencyMode),
        gateLabel: hubGateName,
        serverFrames: hubFrames,
        dbm: liveDbm,
        statusNote: hubUsbStatus.emergencyMode
          ? "Emergency mode"
          : isBleLink
            ? "Bluetooth · Active"
            : `${activeHubConsole.transportLabel} · Beacon master`,
      };
    } else if (
      activeHubConsole.connected &&
      (activeHubConsole.lastConfig?.role === "hub" || activeHubConsole.transportLabel === "Bluetooth")
    ) {
      // Connected Hub whose first JSON STATUS line is still arriving (e.g. Bluetooth Hub right after
      // connect or while streaming binary 5.8 GHz windows): populate immediately from config / BLE port.
      const cfg = activeHubConsole.lastConfig;
      const rawPortName =
        activeHubConsole.rawPort && "portName" in activeHubConsole.rawPort
          ? String((activeHubConsole.rawPort as { portName?: string }).portName || "")
          : "";
      const bleFp = /^ble:[0-9a-f]{8}$/i.test(rawPortName) ? rawPortName.slice(4).toUpperCase() : "";
      const fp = cfg?.fingerprint || bleFp || hubServerTimer?.fingerprint || "-";
      const knownHub =
        fp !== "-"
          ? getKnownHardwareTimers().find((t) => t.role === "hub" && t.fp.toUpperCase() === fp.toUpperCase())
          : undefined;
      const hubSlotLive = activeHubConsole.hubSlotLive.get(1);
      const liveDbm =
        hubSlotLive?.dbm?.length === 8
          ? hubSlotLive.dbm
          : activeHubConsole.hubLastDbm?.length === 8
            ? activeHubConsole.hubLastDbm
            : undefined;
      const hubFrames = Math.max(
        activeHubConsole.hubOwnFrames,
        hubGate?.framesRxCount ?? 0,
        hubServerTimer?.framesRxCount ?? 0
      );
      hub = {
        populated: true,
        online: true,
        label: cfg?.timerLabel || knownHub?.label || hubServerTimer?.timerLabel || "H1",
        fp,
        fw: cfg?.firmwareVersion || knownHub?.fw || hubServerTimer?.firmwareVersion || "-",
        mac: knownHub?.mac || "-",
        ch,
        viaUsb: true,
        emergencyMode: false,
        gateLabel: hubGateName,
        serverFrames: hubFrames,
        dbm: liveDbm,
        statusNote: isBleLink ? "Bluetooth · Active" : `${activeHubConsole.transportLabel} · Beacon master`,
      };
    } else if (s && s.role === 2) {
      const rawBeaconMsAgo = s.beaconMsAgo ?? s.hub?.beaconMsAgo;
      const beaconMsAgo = rawBeaconMsAgo !== undefined && rawBeaconMsAgo >= 0x80000000 ? 0 : rawBeaconMsAgo;
      const hasSlot = !s.emergencyMode && s.slot >= 2;
      const beaconFresh = beaconMsAgo !== undefined && beaconMsAgo < 2500;
      const linked = hasSlot && beaconFresh;
      const parentLabel = s.hub?.label || "";
      const parentFp = s.hub?.fp || "";
      const parentFw = s.hub?.fw || s.fw;
      const parentMac = s.hub?.mac || "—";
      const liveEngineDbm = linked
        ? this.mapSimPilotRssiToFreqs(
            hubServerTimer?.timerId ?? 1,
            hubGate?.lastRssi ?? hubServerTimer?.lastRssi,
            hubGate?.noiseFloorDbm ?? hubServerTimer?.noiseFloorDbm,
            freqs
          )
        : undefined;
      hub = {
        populated: linked,
        online: linked,
        label: linked ? parentLabel : "",
        fp: linked ? parentFp || "—" : "—",
        fw: linked ? parentFw || "—" : "—",
        mac: linked ? parentMac : "—",
        ch,
        viaUsb: false,
        emergencyMode: false,
        gateLabel: linked ? hubGateName : undefined,
        serverFrames: linked ? Math.max(hubGate?.framesRxCount ?? 0, hubServerTimer?.framesRxCount ?? 0) : 0,
        dbm: liveEngineDbm,
        statusNote: linked ? `Sync beacon locked` : hasSlot ? "Beacon lost" : "Not connected",
      };
    } else {
      hub = {
        populated: false,
        online: false,
        label: "",
        fp: "—",
        fw: "—",
        mac: "—",
        ch: 1,
        viaUsb: false,
        emergencyMode: false,
        statusNote: "Not connected",
      };
    }

    const spokes = new Map<number, TopologySpokeInfo>();

    // 1. If connected to a Hub over USB, populate active Spokes detected by the Hub
    if (hubUsbStatus && hubUsbStatus.role === 1 && Array.isArray(hubUsbStatus.spokes)) {
      for (const sp of hubUsbStatus.spokes) {
        if (sp.slot >= 2 && sp.slot <= 7) {
          const rawFp = (sp.fp || "").toUpperCase();
          const isFallbackFp = !rawFp || rawFp.startsWith("53504B");
          const matchedDt = !isFallbackFp
            ? detectedTimers.find((t) => !t.isHub && (t.fingerprint || "").toUpperCase() === rawFp)
            : undefined;
          const gate = matchedDt ? this.store.nodes.find((g) => g.assignedTimerId === matchedDt.timerId) : undefined;
          const slotLive = activeHubConsole.hubSlotLive.get(sp.slot);
          const frames = Math.max(
            sp.frames ?? 0,
            slotLive?.frames ?? 0,
            gate?.framesRxCount ?? 0,
            matchedDt?.framesRxCount ?? 0
          );
          const statusMsAgo = sp.msAgo !== undefined && sp.msAgo >= 0x80000000 ? 0 : sp.msAgo;
          const msAgo =
            slotLive && slotLive.lastFrameAtMs > 0
              ? Math.max(0, Date.now() - slotLive.lastFrameAtMs)
              : statusMsAgo;
          // Ignore synthetic slot placeholders that have never transmitted and Spokes that are no longer active
          if (isFallbackFp && frames === 0) continue;
          if (msAgo !== undefined && msAgo >= 5000) continue;

          const fp = !isFallbackFp && rawFp ? rawFp : `SLOT${sp.slot}`;
          const prevRate = this.spokeRateTracker.get(sp.slot);
          let ratePktPerSec = prevRate?.ratePktPerSec ?? 25;
          if (prevRate) {
            const dtSec = (nowMs - prevRate.atMs) / 1000;
            if (frames > prevRate.frames && dtSec >= 0.75) {
              const instRate = (frames - prevRate.frames) / dtSec;
              ratePktPerSec = prevRate.ratePktPerSec > 0 ? prevRate.ratePktPerSec * 0.6 + instRate * 0.4 : instRate;
              this.spokeRateTracker.set(sp.slot, { frames, atMs: nowMs, ratePktPerSec });
            } else if (frames < prevRate.frames) {
              ratePktPerSec = frames > 0 ? 25 : 0;
              this.spokeRateTracker.set(sp.slot, { frames, atMs: nowMs, ratePktPerSec });
            } else if (frames === prevRate.frames && dtSec >= 1.8) {
              ratePktPerSec = prevRate.ratePktPerSec * 0.4;
              if (ratePktPerSec < 0.5) ratePktPerSec = 0;
              this.spokeRateTracker.set(sp.slot, { frames, atMs: nowMs, ratePktPerSec });
            }
          } else {
            this.spokeRateTracker.set(sp.slot, { frames, atMs: nowMs, ratePktPerSec: frames > 0 ? 25 : 0 });
          }
          const activelyReceiving = frames > 0 && (msAgo === undefined || msAgo < 2500);
          const gateName = gate ? formatTrackPos(gate) : undefined;
          const cleanSpLabel = isFallbackFp ? "" : sp.label;
          const simSpokeDbm = activelyReceiving
            ? this.mapSimPilotRssiToFreqs(
                matchedDt?.timerId ?? sp.slot,
                gate?.lastRssi ?? matchedDt?.lastRssi,
                gate?.noiseFloorDbm ?? matchedDt?.noiseFloorDbm ?? slotLive?.floor,
                freqs
              )
            : undefined;
          const liveSpokeDbm =
            simSpokeDbm ??
            (activelyReceiving && slotLive?.dbm?.length === 8 ? slotLive.dbm : undefined);
          const sourceNote =
            frames === 0
              ? `Joined · 0 frames rx`
              : msAgo !== undefined && msAgo >= 2500
                ? `Stale (${(msAgo / 1000).toFixed(1)}s ago)`
                : `${ratePktPerSec.toFixed(1)} pkt/s · ${frames} frames`;
          spokes.set(sp.slot, {
            slot: sp.slot,
            populated: true,
            espNowActive: activelyReceiving,
            inHubStatus: true,
            viaUsb: false,
            label: matchedDt?.timerLabel || cleanSpLabel || "",
            fp,
            fw: sp.fw || matchedDt?.firmwareVersion || hubUsbStatus.fw,
            mac: sp.mac,
            frames,
            msAgo,
            seq: slotLive?.seq ?? sp.seq,
            dbm: liveSpokeDbm ?? sp.dbm,
            ratePktPerSec,
            serverFrames: gate?.framesRxCount ?? matchedDt?.framesRxCount ?? 0,
            serverGateLabel: gateName,
            serverRssi: liveSpokeDbm,
            sourceNote,
          });
        }
      }
    }

    // 2. Populate Spoke if the main USB connection is a Spoke
    const c = usbPool.mainConsole;
    const spStatus = c.connected ? c.lastStatus : null;
    if (spStatus && spStatus.role === 2) {
      const slotNum = spStatus.slot >= 2 && spStatus.slot <= 7 ? spStatus.slot : 2;
      const rawBeaconMsAgo = spStatus.beaconMsAgo ?? spStatus.hub?.beaconMsAgo;
      const beaconMsAgo = rawBeaconMsAgo !== undefined && rawBeaconMsAgo >= 0x80000000 ? 0 : rawBeaconMsAgo;
      const hasSlot = !spStatus.emergencyMode && spStatus.slot >= 2;
      const beaconFresh = beaconMsAgo !== undefined && beaconMsAgo < 2500;
      const linked = hasSlot && beaconFresh;
      const sFp = (spStatus.fp || "").toUpperCase();
      const matchedDt = sFp ? detectedTimers.find((t) => (t.fingerprint || "").toUpperCase() === sFp) : undefined;
      const gate = matchedDt ? this.store.nodes.find((g) => g.assignedTimerId === matchedDt.timerId) : undefined;
      const gateName = gate ? formatTrackPos(gate) : undefined;
      const existingFromHub = spokes.get(slotNum);
      const isCurrentConsole = s === spStatus;
      const rfActive = !spStatus.emergencyMode && spStatus.rf?.enabled !== false && !spStatus.scanLive;
      const liveSpokeDbm = rfActive
        ? this.mapSimPilotRssiToFreqs(
            matchedDt?.timerId ?? slotNum,
            gate?.lastRssi ?? matchedDt?.lastRssi,
            gate?.noiseFloorDbm ?? matchedDt?.noiseFloorDbm ?? spStatus.rf?.floorDb,
            freqs
          )
        : [-128, -128, -128, -128, -128, -128, -128, -128];
      spokes.set(slotNum, {
        slot: slotNum,
        populated: true,
        espNowActive: linked || Boolean(existingFromHub?.espNowActive),
        inHubStatus: linked || Boolean(existingFromHub?.inHubStatus),
        viaUsb: true,
        label: spStatus.label || matchedDt?.timerLabel || existingFromHub?.label || "",
        fp: spStatus.fp || existingFromHub?.fp || "—",
        fw: spStatus.fw || existingFromHub?.fw || "—",
        mac: spStatus.chip?.mac || existingFromHub?.mac,
        frames: existingFromHub?.frames ?? gate?.framesRxCount ?? matchedDt?.framesRxCount ?? 0,
        msAgo: existingFromHub?.msAgo,
        beaconMsAgo,
        seq: existingFromHub?.seq ?? spStatus.sweeps,
        dbm:
          isCurrentConsole && this.freshLive()?.dbm?.length === 8
            ? this.freshLive()!.dbm
            : liveSpokeDbm?.length === 8
              ? liveSpokeDbm
              : spStatus.dbm?.length === 8
                ? spStatus.dbm
                : existingFromHub?.dbm,
        ratePktPerSec: existingFromHub?.ratePktPerSec ?? (linked ? 25 : 0),
        serverFrames: gate?.framesRxCount ?? matchedDt?.framesRxCount ?? 0,
        serverGateLabel: gateName,
        serverRssi: liveSpokeDbm,
        sourceNote: spStatus.emergencyMode
          ? `Emergency mode · ${c.transportLabel}`
          : linked
            ? `${c.transportLabel} · Synced (${beaconMsAgo ?? 0} ms)`
            : hasSlot
              ? `${c.transportLabel} · Beacon lost`
              : `${c.transportLabel} · Searching for Hub`,
      });
    }

    // 3. Fill any remaining slots (2..7) with empty placeholders (no pre-assigned timer name)
    for (let slotNum = 2; slotNum <= 7; slotNum++) {
      if (!spokes.has(slotNum)) {
        spokes.set(slotNum, {
          slot: slotNum,
          populated: false,
          espNowActive: false,
          inHubStatus: false,
          viaUsb: false,
          label: "",
          fp: "—",
          fw: "—",
          frames: 0,
          ratePktPerSec: 0,
          serverFrames: 0,
          sourceNote: "Open slot",
        });
      }
    }

    return { hub, spokes };
  }

  private isMobileTopologyViewport(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 860px)").matches
    );
  }

  private ensureSelectedSlot(hub: TopologyHubInfo, spokes: Map<number, TopologySpokeInfo>): number {
    const s = this.activeStatus();
    const isMobile = this.isMobileTopologyViewport();
    if (this.userPickedSlot && this.selectedSlot !== null && this.selectedSlot >= 1 && this.selectedSlot <= 7) {
      // On mobile, empty spoke slots are hidden, so never stay stuck on an unpopulated spoke slot.
      if (!isMobile || this.selectedSlot === 1 || spokes.get(this.selectedSlot)?.populated) {
        return this.selectedSlot;
      }
      this.userPickedSlot = false;
    }
    if (this.selectedSlot !== null && this.selectedSlot >= 2 && this.selectedSlot <= 7) {
      const sp = spokes.get(this.selectedSlot);
      if (sp?.populated) return this.selectedSlot;
    }
    if (s && s.role === 2 && s.slot >= 2 && s.slot <= 7) {
      this.selectedSlot = s.slot;
      return this.selectedSlot;
    }
    if (this.store.timingHardwareMode === "slaprf_ble" && hub.populated) {
      this.selectedSlot = 1;
      return 1;
    }
    const firstActiveSpoke = [...spokes.values()].find((sp) => sp.espNowActive);
    if (firstActiveSpoke) {
      this.selectedSlot = firstActiveSpoke.slot;
      return this.selectedSlot;
    }
    const firstPopulatedSpoke = [...spokes.values()].find((sp) => sp.populated);
    if (firstPopulatedSpoke) {
      this.selectedSlot = firstPopulatedSpoke.slot;
      return this.selectedSlot;
    }
    this.selectedSlot = 1;
    return 1;
  }

  private renderAll(): void {
    const mode = this.store.timingHardwareMode;
    const isBleMode = mode === "slaprf_ble";
    const isLapRF = mode === "laprf";
    const isRHNet = mode === "rotorhazard";
    const isRHUSB = mode === "rotorhazard_usb";
    const slaprfWrap = this.el.querySelector<HTMLElement>('[data-slot="slaprf-sections"]');
    const laprfWrap = this.el.querySelector<HTMLElement>('[data-slot="laprf-sections"]');
    const rhWrap = this.el.querySelector<HTMLElement>('[data-slot="rh-sections"]');
    const rhUsbWrap = this.el.querySelector<HTMLElement>('[data-slot="rh-usb-sections"]');
    if (slaprfWrap) slaprfWrap.style.display = !isLapRF && !isRHNet && !isRHUSB ? "contents" : "none";
    if (laprfWrap) laprfWrap.style.display = isLapRF ? "contents" : "none";
    if (rhWrap) rhWrap.style.display = isRHNet ? "contents" : "none";
    if (rhUsbWrap) rhUsbWrap.style.display = isRHUSB ? "contents" : "none";

    if (isLapRF) {
      this.renderLapRFView();
      return;
    }
    if (isRHNet) {
      this.renderRotorHazardView();
      return;
    }
    if (isRHUSB) {
      this.renderRotorHazardUSBView();
      return;
    }

    if (slaprfWrap) {
      const connIntro = slaprfWrap.querySelector<HTMLElement>('[data-section-anchor="connection"] > .settings-intro');
      if (connIntro) {
        const wantConnHtml = isBleMode
          ? `<h2>Bluetooth Hub</h2><p>Connect your SlapRF Bluetooth Hub wirelessly over Bluetooth LE to inspect pairing status, 2.4 GHz ESP-NOW Spokes, and live 8-channel 5.8 GHz readings.</p>`
          : `<h2>Connection</h2><p>Connect the Hub (or a Spoke) over USB-C to inspect the 2.4 GHz network and 5.8 GHz channel readings.</p>`;
        if (connIntro.innerHTML !== wantConnHtml) {
          connIntro.innerHTML = wantConnHtml;
        }
      }
      const topoSec = slaprfWrap.querySelector<HTMLElement>('[data-section-anchor="topology"]');
      if (topoSec) {
        topoSec.hidden = false;
        topoSec.style.display = "";
      }
      const timerIntro = slaprfWrap.querySelector<HTMLElement>('[data-section-anchor="timer"] > .settings-intro');
      if (timerIntro) {
        const wantTimerHtml = isBleMode
          ? `<h2>Timer</h2><p>Identity, Bluetooth LE + 2.4 GHz ESP-NOW link stats, and live 5.8 GHz channel readings for the selected slot.</p>`
          : `<h2>Timer</h2><p>Identity, 2.4 GHz TDMA link stats, and live 5.8 GHz channel readings for the selected slot.</p>`;
        if (timerIntro.innerHTML !== wantTimerHtml) {
          timerIntro.innerHTML = wantTimerHtml;
        }
      }
    }

    const connHost = this.el.querySelector<HTMLElement>('[data-slot="connection"]');
    patchUsbConnectionBar(connHost, {
      activeConsole: usbPool.mainConsole,
      showAllPorts: isBleMode ? false : this.showAllPorts,
      bluetoothMode: isBleMode,
      error: this.connError,
    });
    const { hub, spokes } = this.buildTopologyState();
    const sel = this.ensureSelectedSlot(hub, spokes);
    this.renderTopologySection(hub, spokes, sel);
    this.renderTimerSection(hub, spokes, sel);
  }

  private renderLapRFView(): void {
    const connHost = this.slot("laprf-connection");
    const timersHost = this.slot("laprf-timers");
    const snaps = sharedLapRFLink.snapshots(this.store);
    const errText = this.laprfError || sharedLapRFLink.errorMessage || "";

    const activeEl = document.activeElement as HTMLElement | null;
    const focusedInsideConn = Boolean(
      activeEl && connHost.contains(activeEl) && activeEl.tagName === "INPUT"
    );

    const connSig = JSON.stringify({
      busy: this.laprfBusy,
      scanning: this.laprfScanning,
      subnet: this.laprfScannedSubnet,
      err: errText,
      discovered: this.laprfDiscovered,
      connectedEndpoints: snaps.filter((s) => s.connected).map((s) => s.endpoint),
    });

    if (!focusedInsideConn && connSig !== this.lastLaprfConnSig) {
      this.lastLaprfConnSig = connSig;
      const connectedEndpoints = new Set(snaps.filter((s) => s.connected).map((s) => s.endpoint));
      const discoveredHtml =
        this.laprfDiscovered.length > 0
          ? `<div style="padding:10px 14px;border-top:1px solid var(--border,rgba(255,255,255,0.08));display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span class="muted" style="font-size:12px">Discovered on ${esc(this.laprfScannedSubnet || "LAN")} (${this.laprfDiscovered.length})</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                ${this.laprfDiscovered
                  .map((d) => {
                    const ep = `${d.host}:${d.port || 5403}`;
                    const isConn = Boolean(d.connected || connectedEndpoints.has(ep));
                    const vStr = d.voltageMv && d.voltageMv > 0 ? ` · ${(d.voltageMv / 1000).toFixed(1)} V` : "";
                    return `
                      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:6px;background:rgba(255,255,255,0.02)">
                        <span class="status-dot ${isConn ? "is-up" : ""}"></span>
                        <span class="mono" style="font-size:12px"><strong>${esc(d.label || "LapRF")}</strong> · ${esc(ep)}${esc(vStr)}</span>
                        ${
                          isConn
                            ? `<span class="badge mono">Connected</span>`
                            : `<button class="btn btn-sm btn-ghost" type="button" data-action="laprf-connect-discovered" data-host="${esc(d.host)}" data-port="${d.port || 5403}" data-label="${esc(d.label || "")}" ${this.laprfBusy ? "disabled" : ""}>Connect</button>`
                        }
                      </div>`;
                  })
                  .join("")}
              </div>
            </div>`
          : this.laprfScannedSubnet
            ? `<div style="padding:10px 14px;border-top:1px solid var(--border,rgba(255,255,255,0.08))"><span class="note">No powered-on LapRF timers responded on ${esc(this.laprfScannedSubnet)} TCP :5403.</span></div>`
            : "";

      connHost.innerHTML = `
        <div class="card card-flush">
          <div style="padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;justify-content:space-between">
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
              <label style="display:flex;flex-direction:column;gap:4px">
                <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Ethernet IP</span>
                <input
                  class="input mono"
                  type="text"
                  value="${esc(this.laprfHost)}"
                  data-field="laprf-host"
                  placeholder="192.168.1.2"
                  style="width:142px;padding:5px 9px;font-size:13px"
                />
              </label>
              <label style="display:flex;flex-direction:column;gap:4px">
                <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Port</span>
                <input
                  class="input mono"
                  type="number"
                  value="${this.laprfPort}"
                  data-field="laprf-port"
                  style="width:82px;padding:5px 8px;font-size:13px"
                />
              </label>
              <button class="btn btn-ghost" type="button" data-action="laprf-connect-eth" ${this.laprfBusy ? "disabled" : ""}>
                ${icons.wifi(14)}<span>${this.laprfBusy ? "Connecting…" : "Connect Ethernet"}</span>
              </button>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn btn-ghost" type="button" data-action="laprf-connect-usb" ${this.laprfBusy ? "disabled" : ""}>
                ${icons.plug(14)}<span>Connect USB</span>
              </button>
            </div>
          </div>
          ${errText ? `<div class="sim-error-note" style="margin:0 16px 12px">${esc(errText)}</div>` : ""}
        </div>`;

      const discoverHost = this.slot("laprf-discover");
      if (discoverHost) {
        discoverHost.innerHTML = `
          <div class="card card-flush">
            <div style="padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
              <div style="display:flex;align-items:center;gap:10px">
                <button class="btn btn-ghost" type="button" data-action="laprf-scan-lan" ${this.laprfScanning ? "disabled" : ""}>
                  ${icons.target(14)}<span>${this.laprfScanning ? "Scanning…" : "Scan LAN"}</span>
                </button>
                <span class="note">Probes local subnet for LapRF 8-Way units on TCP :${this.laprfPort || 5403}</span>
              </div>
            </div>
            ${discoveredHtml}
          </div>`;
      }
    }

    const gateByTimer = new Map<number, string>();
    for (const g of this.store.nodes) {
      if (g.assignedTimerId > 0) {
        gateByTimer.set(
          g.assignedTimerId,
          `Track #${g.trackOrder + 1}${g.role === "START_FINISH" ? " (Start)" : ""}`
        );
      }
    }

    const structSig = JSON.stringify({
      snaps: snaps.map((s) => ({
        id: s.timerId,
        label: s.label,
        ep: s.endpoint,
        tr: s.transport,
        conn: s.connected,
        gate: gateByTimer.get(s.timerId) || "",
        freqs: s.slotFreqsMhz ?? [],
        thresholds: s.slotThresholds ?? [],
      })),
    });

    const pctRssi = (val: number) =>
      Math.max(0, Math.min(100, ((val - 300) / (3400 - 300)) * 100));

    if (structSig === this.lastLaprfTimersStructSig && snaps.length > 0) {
      for (const snap of snaps) {
        const card = timersHost.querySelector<HTMLElement>(`[data-laprf-card="${snap.timerId}"]`);
        if (!card) continue;
        const voltEl = card.querySelector<HTMLElement>('[data-laprf-kpi="voltage"]');
        const voltText = snap.voltageMv > 0 ? `${(snap.voltageMv / 1000).toFixed(1)} V` : "—";
        if (voltEl && voltEl.textContent !== voltText) voltEl.textContent = voltText;

        const gateEl = card.querySelector<HTMLElement>('[data-laprf-kpi="gate-state"]');
        const gateText = !snap.connected ? "Offline" : snap.gateArmed ? "Armed" : "Standby";
        if (gateEl && gateEl.textContent !== gateText) gateEl.textContent = gateText;

        const rtcEl = card.querySelector<HTMLElement>('[data-laprf-kpi="rtc"]');
        const rtcText = !snap.connected
          ? "—"
          : snap.rtcSynced
            ? `Synced (${snap.rtcOffsetMs >= 0 ? "+" : ""}${Math.round(snap.rtcOffsetMs)} ms)`
            : "Syncing…";
        if (rtcEl && rtcEl.textContent !== rtcText) rtcEl.textContent = rtcText;

        for (let idx = 0; idx < 8; idx++) {
          const freq = snap.slotFreqsMhz?.[idx] ?? 0;
          const active = freq > 0;
          const val = snap.slotRssi?.[idx] ?? 0;
          const valid = Boolean(active && snap.connected && val > 0);
          const widthStr = `${(valid ? pctRssi(val) : 0).toFixed(1)}%`;
          const valStr = !active ? "" : valid ? `${Math.round(val)}` : "—";
          const fillEl = card.querySelector<HTMLElement>(`[data-laprf-bar-fill="${idx}"]`);
          if (fillEl && fillEl.style.width !== widthStr) fillEl.style.width = widthStr;
          const valEl = card.querySelector<HTMLElement>(`[data-laprf-bar-val="${idx}"]`);
          if (valEl) {
            if (valEl.textContent !== valStr) valEl.textContent = valStr;
            valEl.classList.toggle("mono", valid);
          }
        }
      }
      return;
    }

    this.lastLaprfTimersStructSig = structSig;

    if (snaps.length === 0) {
      timersHost.innerHTML = `
        <div class="card empty-note" style="padding:18px">
          No LapRF 8-Way timers connected yet. Enter the timer's IP above, click <strong>Scan LAN</strong>, or connect over USB.
        </div>`;
      return;
    }

    timersHost.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        ${snaps
          .map((snap) => {
            const color = timerColor(this.store, snap.timerId);
            const assignedGate = gateByTimer.get(snap.timerId);
            const voltText = snap.voltageMv > 0 ? `${(snap.voltageMv / 1000).toFixed(1)} V` : "—";
            const gateText = !snap.connected ? "Offline" : snap.gateArmed ? "Armed" : "Standby";
            const rtcText = !snap.connected
              ? "—"
              : snap.rtcSynced
                ? `Synced (${snap.rtcOffsetMs >= 0 ? "+" : ""}${Math.round(snap.rtcOffsetMs)} ms)`
                : "Syncing…";

            const barsHtml = Array.from({ length: 8 }, (_, idx) => {
              const freq = snap.slotFreqsMhz?.[idx] ?? 0;
              const active = freq > 0;
              const val = snap.slotRssi?.[idx] ?? 0;
              const valid = Boolean(active && snap.connected && val > 0);
              const widthPct = valid ? pctRssi(val) : 0;
              const thresh = snap.slotThresholds?.[idx] || 800;
              const threshPct = pctRssi(thresh);
              const labelHtml = active
                ? `<span class="debug-ch-inline" style="background:#94a3b8"></span><strong>Slot ${idx + 1}</strong> <span class="muted mono">${esc(formatHardwareFreq(freq))}</span>`
                : `<span class="debug-ch-inline" style="background:transparent;box-shadow:inset 0 0 0 1.5px #64748b"></span><strong>Slot ${idx + 1}</strong> <span class="muted">Disabled</span>`;

              return `
                <div class="debug-net-inspector-bar-row net-node-bar-row ${active ? "" : "is-muted"}">
                  <span class="net-node-bar-label">${labelHtml}</span>
                  <div class="debug-bar-track" style="position:relative">
                    <span class="debug-bar-fill" data-laprf-bar-fill="${idx}" style="width:${widthPct.toFixed(1)}%"></span>
                    ${
                      active
                        ? `<span title="Threshold ${Math.round(thresh)}" style="position:absolute;top:-2px;bottom:-2px;left:${threshPct.toFixed(1)}%;width:2px;background:rgba(255,255,255,0.45);pointer-events:none"></span>`
                        : ""
                    }
                  </div>
                  <span class="net-node-bar-val ${valid ? "mono" : ""}" data-laprf-bar-val="${idx}">${!active ? "" : valid ? `${Math.round(val)}` : "—"}</span>
                </div>`;
            }).join("");

            return `
              <div class="card card-flush" data-laprf-card="${snap.timerId}">
                <div class="net-device-card-head">
                  <span class="debug-led-status">
                    <span class="timer-color-dot ${snap.connected ? "is-live" : "is-off"}" style="--c:${esc(color)}" title="${snap.connected ? "Connected" : "Disconnected"}"></span>
                    <span class="debug-head-note">
                      <strong>${esc(snap.label)}</strong> · <span class="mono">${esc(snap.endpoint)}</span>
                    </span>
                  </span>
                  <div class="debug-connect-actions">
                    <span class="badge">${assignedGate ? esc(assignedGate) : "Unassigned"}</span>
                    <button class="btn btn-sm btn-ghost" type="button" data-action="laprf-disconnect" data-timer-id="${snap.timerId}">
                      Disconnect
                    </button>
                  </div>
                </div>

                <div class="debug-net-inspector-kpis net-device-card-kpis">
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Supply voltage</span>
                    <strong class="debug-net-inspector-kpi-val mono" data-laprf-kpi="voltage">${voltText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Gate state</span>
                    <strong class="debug-net-inspector-kpi-val" data-laprf-kpi="gate-state">${gateText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Clock sync</span>
                    <strong class="debug-net-inspector-kpi-val mono" data-laprf-kpi="rtc">${rtcText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Track position</span>
                    <strong class="debug-net-inspector-kpi-val">${assignedGate ? esc(assignedGate) : `<span class="note">Off track</span>`}</strong>
                  </div>
                </div>

                <div class="net-device-card-body">
                  <div class="debug-subbox">
                    <div class="debug-net-inspector-bars-wrap">
                      <div class="debug-subbar">
                        <span class="debug-chart-title">8-slot receiver RSSI (300–3500 scale)</span>
                        <span class="note">Tick mark = slot crossing threshold</span>
                      </div>
                      <div class="debug-net-inspector-bars">${barsHtml}</div>
                    </div>
                  </div>
                </div>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  private defaultRhCredsFor(host: string, port: number, timerId?: number): { user: string; pass: string } {
    const ep = `${host}:${port || DEFAULT_RH_PORT}`;
    const cached = this.rhCredsByEndpoint.get(ep);
    if (cached) {
      return { user: cached.user, pass: cached.pass };
    }
    if (this.store.simulatorRunning) {
      const units = this.store.simState?.rotorhazardUnits ?? [];
      const u = units.find(
        (x) =>
          (timerId && x.timerId === timerId) ||
          (x.host === host && (x.port || DEFAULT_RH_PORT) === (port || DEFAULT_RH_PORT))
      );
      if (u) {
        return {
          user: u.adminUser ?? DEFAULT_RH_ADMIN_USER,
          pass: u.adminPass ?? DEFAULT_RH_ADMIN_PASS,
        };
      }
    }
    const saved = sharedRHLink
      .loadSavedTargets()
      .find((t) => t.host === host && (t.port || DEFAULT_RH_PORT) === (port || DEFAULT_RH_PORT));
    if (saved?.adminUser) {
      return { user: saved.adminUser, pass: DEFAULT_RH_ADMIN_PASS };
    }
    return { user: DEFAULT_RH_ADMIN_USER, pass: DEFAULT_RH_ADMIN_PASS };
  }

  private openRhCredPrompt(target: {
    scope: "manual" | "discovered" | "card";
    key: string;
    host: string;
    port: number;
    label: string;
    timerId?: number;
  }): void {
    const creds = this.defaultRhCredsFor(target.host, target.port, target.timerId);
    this.rhCredPrompt = target;
    this.rhUser = creds.user;
    this.rhPass = creds.pass;
    this.rhRevealPass = false;
    this.rhError = null;
    this.lastRhConnSig = "";
    this.lastRhTimersStructSig = "";
    this.renderAll();
    const passInp = this.el.querySelector<HTMLInputElement>('input[data-field="rh-cred-pass"]');
    passInp?.focus();
    passInp?.select();
  }

  private async submitRhCredPrompt(): Promise<void> {
    if (this.rhBusy || !this.rhCredPrompt) return;
    const target = this.rhCredPrompt;
    const ep = `${target.host}:${target.port || DEFAULT_RH_PORT}`;
    this.rhCredsByEndpoint.set(ep, { user: this.rhUser, pass: this.rhPass });
    this.rhBusy = true;
    this.rhError = null;
    this.lastRhConnSig = "";
    this.lastRhTimersStructSig = "";
    this.renderAll();
    try {
      await sharedRHLink.connectDevice(this.store, this.api, {
        host: target.host,
        port: target.port,
        adminUser: this.rhUser,
        adminPass: this.rhPass,
        preferredLabel: target.scope !== "manual" ? target.label : undefined,
        preferredTimerId: target.timerId,
      });
      this.rhCredPrompt = null;
      if (this.rhDiscovered.length > 0) {
        const res = await sharedRHLink
          .scanLan(this.store, this.api, target.port || this.rhPort)
          .catch(() => null);
        if (res) {
          this.rhScannedSubnet = res.subnet;
          this.rhDiscovered = res.devices;
        }
      }
    } catch (err) {
      this.rhError = err instanceof Error ? err.message : String(err);
    } finally {
      this.rhBusy = false;
      this.lastRhConnSig = "";
      this.lastRhTimersStructSig = "";
      this.lastRhUsbConnSig = "";
      this.lastRhUsbTimersStructSig = "";
      this.renderAll();
    }
  }

  private renderRhInlineCredsBar(titleText: string): string {
    const eyeLabel = this.rhRevealPass ? "Hide admin password" : "Reveal admin password";
    return `
      <div data-rh-creds-prompt="1" style="padding:12px 16px;border-top:1px solid var(--border,rgba(255,255,255,0.08));background:rgba(255,255,255,0.02);display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;justify-content:space-between">
        <div style="display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-width:260px">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px">
            <strong>${esc(titleText)}</strong>
            <span class="note">— each RotorHazard server uses its own admin credentials</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
            <label style="display:flex;flex-direction:column;gap:4px">
              <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Admin Username</span>
              <input
                class="input mono"
                type="text"
                value="${esc(this.rhUser)}"
                data-field="rh-cred-user"
                placeholder="admin"
                autocomplete="off"
                spellcheck="false"
                style="width:132px;padding:5px 9px;font-size:13px"
              />
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Admin Password</span>
              <div class="flasher-pass-wrap" style="width:176px">
                <input
                  class="input flasher-pass-input mono"
                  type="${this.rhRevealPass ? "text" : "password"}"
                  value="${esc(this.rhPass)}"
                  data-field="rh-cred-pass"
                  placeholder="rotorhazard"
                  autocomplete="off"
                  spellcheck="false"
                  style="padding:5px 30px 5px 9px;font-size:13px"
                />
                <button
                  type="button"
                  class="flasher-pass-toggle"
                  data-action="rh-toggle-pass"
                  aria-label="${eyeLabel}"
                  title="${eyeLabel}"
                >
                  ${this.rhRevealPass ? icons.eyeOff(15) : icons.eye(15)}
                </button>
              </div>
            </label>
            <button class="btn btn-armed" type="button" data-action="rh-cred-submit" ${this.rhBusy ? "disabled" : ""}>
              ${icons.wifi(14)}<span>${this.rhBusy ? "Connecting…" : "Sign in & Connect"}</span>
            </button>
            <button class="btn btn-ghost" type="button" data-action="rh-cred-cancel" ${this.rhBusy ? "disabled" : ""}>
              Cancel
            </button>
          </div>
        </div>
      </div>`;
  }

  private renderRotorHazardView(): void {
    const connHost = this.slot("rh-connection");
    const discoverHost = this.slot("rh-discover");
    const timersHost = this.slot("rh-timers");
    const snaps = sharedRHLink.snapshots(this.store);
    const errText = this.rhError || sharedRHLink.errorMessage || "";
    const canScanLan = this.store.simulatorRunning || capabilitiesSnapshot().portable;

    const activeEl = document.activeElement as HTMLElement | null;
    const focusedInsideConn = Boolean(
      activeEl &&
        (connHost.contains(activeEl) || (discoverHost && discoverHost.contains(activeEl))) &&
        activeEl.tagName === "INPUT"
    );
    const focusedInsideTimers = Boolean(
      activeEl && timersHost.contains(activeEl) && activeEl.tagName === "INPUT"
    );

    const connPrompt =
      this.rhCredPrompt && this.rhCredPrompt.scope !== "card" ? this.rhCredPrompt : null;

    const connSig = JSON.stringify({
      busy: this.rhBusy,
      scanning: this.rhScanning,
      canScanLan,
      prompt: connPrompt ? `${connPrompt.key}:${this.rhRevealPass ? 1 : 0}` : "",
      subnet: this.rhScannedSubnet,
      err: errText,
      discovered: this.rhDiscovered,
      connectedEndpoints: snaps.filter((s) => s.connected).map((s) => s.endpoint),
    });

    if (!focusedInsideConn && connSig !== this.lastRhConnSig) {
      this.lastRhConnSig = connSig;
      const connectedEndpoints = new Set(snaps.filter((s) => s.connected).map((s) => s.endpoint));
      const discoveredHtml =
        this.rhDiscovered.length > 0
          ? `<div style="padding:10px 14px;border-top:1px solid var(--border,rgba(255,255,255,0.08));display:flex;flex-direction:column;gap:8px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span class="muted" style="font-size:12px">Discovered RotorHazard devices on ${esc(this.rhScannedSubnet || "LAN")} (${this.rhDiscovered.length})</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                ${this.rhDiscovered
                  .map((d, idx) => {
                    const ep = `${d.host}:${d.port || DEFAULT_RH_PORT}`;
                    const isConn = Boolean(d.connected || connectedEndpoints.has(ep));
                    const nodesMeta = d.nodeCount ? ` · ${d.nodeCount} nodes` : "";
                    const rawLbl = d.label?.trim() || "";
                    const dLabel = rawLbl
                      ? /^rh(\d+)$/i.test(rawLbl)
                        ? `R${rawLbl.slice(2)}`
                        : rawLbl
                      : `R${idx + 1}`;
                    const dColor = d.timerId ? timerColor(this.store, d.timerId) : channelColor(idx);
                    const isPrompted = Boolean(
                      connPrompt &&
                        connPrompt.scope === "discovered" &&
                        connPrompt.host === d.host &&
                        connPrompt.port === (d.port || DEFAULT_RH_PORT)
                    );
                    return `
                      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid ${isPrompted ? "var(--accent)" : "var(--border,rgba(255,255,255,0.1))"};border-radius:6px;background:rgba(255,255,255,0.02)">
                        <span class="timer-color-dot ${isConn ? "is-live" : "is-off"}" style="--c:${esc(dColor)}"></span>
                        <span style="font-size:12px"><strong>${esc(dLabel)}</strong> · <span class="mono">${esc(ep)}</span>${esc(nodesMeta)}</span>
                        ${
                          isConn
                            ? `<span class="badge">Connected</span>`
                            : `<button class="btn btn-sm btn-ghost" type="button" data-action="rh-open-device-creds" data-cred-scope="discovered" data-host="${esc(d.host)}" data-port="${d.port || DEFAULT_RH_PORT}" data-label="${esc(dLabel)}" ${d.timerId ? `data-timer-id="${d.timerId}"` : ""} ${this.rhBusy ? "disabled" : ""}>Connect…</button>`
                        }
                      </div>`;
                  })
                  .join("")}
              </div>
            </div>`
          : this.rhScannedSubnet
            ? `<div style="padding:10px 14px;border-top:1px solid var(--border,rgba(255,255,255,0.08))"><span class="note">No powered-on RotorHazard devices responded on ${esc(this.rhScannedSubnet)} :${this.rhPort}.</span></div>`
            : "";

      const scanTitle = canScanLan
        ? "Scan the local subnet for RotorHazard servers"
        : "Automatic LAN scanning requires a SlapRF Server (or Simulation active). Enter the RotorHazard IP address under Manual connection.";

      const manualPromptHtml =
        connPrompt && connPrompt.scope === "manual"
          ? this.renderRhInlineCredsBar(
              `Credentials for ${connPrompt.host}:${connPrompt.port}`
            )
          : "";

      const discoverPromptHtml =
        connPrompt && connPrompt.scope === "discovered"
          ? this.renderRhInlineCredsBar(
              `Credentials for ${connPrompt.label} (${connPrompt.host}:${connPrompt.port})`
            )
          : "";

      const errInDiscover = Boolean(connPrompt && connPrompt.scope === "discovered");

      connHost.innerHTML = `
        <div class="card card-flush">
          <div style="padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;justify-content:space-between">
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
              <label style="display:flex;flex-direction:column;gap:4px">
                <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Host IP</span>
                <input
                  class="input mono"
                  type="text"
                  value="${esc(this.rhHost)}"
                  data-field="rh-host"
                  placeholder="192.168.1.101"
                  style="width:142px;padding:5px 9px;font-size:13px"
                />
              </label>
              <label style="display:flex;flex-direction:column;gap:4px">
                <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Port</span>
                <input
                  class="input mono"
                  type="number"
                  value="${this.rhPort}"
                  data-field="rh-port"
                  style="width:82px;padding:5px 8px;font-size:13px"
                />
              </label>
              <button class="btn btn-ghost" type="button" data-action="rh-open-manual-creds" ${this.rhBusy ? "disabled" : ""}>
                ${icons.wifi(14)}<span>Connect…</span>
              </button>
            </div>
            <span class="note">Enter a RotorHazard server IP and port to sign in with its admin credentials</span>
          </div>
          ${errText && !errInDiscover ? `<div class="sim-error-note" style="margin:0 16px 12px">${esc(errText)}</div>` : ""}
          ${manualPromptHtml}
        </div>`;

      if (discoverHost) {
        discoverHost.innerHTML = `
          <div class="card card-flush">
            <div style="padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <button class="btn btn-ghost" type="button" data-action="rh-scan-lan" ${this.rhScanning || !canScanLan ? "disabled" : ""} title="${esc(scanTitle)}">
                  ${icons.target(14)}<span>${this.rhScanning ? "Scanning…" : "Scan LAN"}</span>
                </button>
                <span class="note">${
                  canScanLan
                    ? `Scans local subnet for RotorHazard timing servers on port ${this.rhPort || DEFAULT_RH_PORT}`
                    : "Automatic LAN discovery requires SlapRF Server mode (or Simulation active)"
                }</span>
              </div>
            </div>
            ${errText && errInDiscover ? `<div class="sim-error-note" style="margin:0 16px 12px">${esc(errText)}</div>` : ""}
            ${discoveredHtml}
            ${discoverPromptHtml}
          </div>`;
      }
    }

    const gateByTimer = new Map<number, { gateId: number; label: string }>();
    for (const g of this.store.nodes) {
      if (g.assignedTimerId > 0) {
        gateByTimer.set(g.assignedTimerId, {
          gateId: g.gateId,
          label: `Track #${g.trackOrder + 1}${g.role === "START_FINISH" ? " (Start)" : ""}`,
        });
      }
    }

    const pctRssi = (val: number) => Math.max(0, Math.min(100, (val / 255) * 100));
    const cardPrompt =
      this.rhCredPrompt && this.rhCredPrompt.scope === "card" ? this.rhCredPrompt : null;

    const structSig = JSON.stringify({
      cardPrompt: cardPrompt ? `${cardPrompt.key}:${this.rhRevealPass ? 1 : 0}:${this.rhBusy ? 1 : 0}` : "",
      snaps: snaps.map((s) => {
        const gMeta = gateByTimer.get(s.timerId);
        return {
          id: s.timerId,
          label: s.label,
          ep: s.endpoint,
          conn: s.connected,
          authOk: s.authOk,
          authKnown: s.authKnown,
          ver: s.serverVersion,
          nodes: s.nodeCount,
          gate: gMeta?.label || "",
          freqs: s.nodeFreqsMhz ?? [],
          enters: s.nodeEnterLevels ?? [],
          exits: s.nodeExitLevels ?? [],
        };
      }),
    });

    if (!focusedInsideTimers && structSig === this.lastRhTimersStructSig && snaps.length > 0) {
      for (const snap of snaps) {
        const card = timersHost.querySelector<HTMLElement>(`[data-rh-card="${snap.timerId}"]`);
        if (!card) continue;
        const gateEl = card.querySelector<HTMLElement>('[data-rh-kpi="gate-state"]');
        const gateText = !snap.connected ? "Offline" : snap.gateArmed ? "Armed" : "Standby";
        if (gateEl && gateEl.textContent !== gateText) gateEl.textContent = gateText;

        const clkEl = card.querySelector<HTMLElement>('[data-rh-kpi="clock"]');
        const clkText = !snap.connected
          ? "—"
          : snap.clockSynced
            ? `Synced (${Math.abs(snap.clockOffsetMs) < 0.5 ? "<1" : snap.clockOffsetMs.toFixed(1)} ms RTT)`
            : "Syncing…";
        if (clkEl && clkEl.textContent !== clkText) clkEl.textContent = clkText;

        const nodeCount = Math.max(1, Math.min(8, snap.nodeCount || 8));
        for (let idx = 0; idx < nodeCount; idx++) {
          const freq = snap.nodeFreqsMhz?.[idx] ?? 0;
          const active = freq > 0;
          const val = snap.slotRssi?.[idx] ?? 0;
          const crossing = Boolean(snap.crossingFlag?.[idx]);
          const valid = Boolean(active && snap.connected && val > 0);
          const widthStr = `${(valid ? pctRssi(val) : 0).toFixed(1)}%`;
          const isCross = Boolean(active && snap.connected && crossing);
          const valStr = !active
            ? ""
            : !snap.connected
              ? "—"
              : `${Math.round(val)}`;
          const fillEl = card.querySelector<HTMLElement>(`[data-rh-bar-fill="${idx}"]`);
          if (fillEl && fillEl.style.width !== widthStr) fillEl.style.width = widthStr;
          const crossEl = card.querySelector<HTMLElement>(`[data-rh-bar-cross="${idx}"]`);
          if (crossEl) {
            const wantCross = isCross ? "CROSSING" : "";
            if (crossEl.textContent !== wantCross) crossEl.textContent = wantCross;
            crossEl.hidden = !isCross;
          }
          const valEl = card.querySelector<HTMLElement>(`[data-rh-bar-val="${idx}"]`);
          if (valEl) {
            if (valEl.textContent !== valStr) valEl.textContent = valStr;
            valEl.classList.toggle("mono", Boolean(active && snap.connected));
            valEl.classList.toggle("is-crossing", isCross);
          }
        }
      }
      return;
    }

    if (focusedInsideTimers) {
      return;
    }
    this.lastRhTimersStructSig = structSig;

    if (snaps.length === 0) {
      timersHost.innerHTML = `
        <div class="card empty-note" style="padding:18px">
          No RotorHazard devices connected yet. Enter a RotorHazard server IP above and click <strong>Connect…</strong>, or click <strong>Scan LAN</strong>.
        </div>`;
      return;
    }

    timersHost.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        ${snaps
          .map((snap) => {
            const color = timerColor(this.store, snap.timerId);
            const gMeta = gateByTimer.get(snap.timerId);
            const assignedGate = gMeta?.label;
            const nodeCount = Math.max(1, Math.min(8, snap.nodeCount || 8));
            const rawSnapLbl = snap.label?.trim() || "";
            const snapLabel = rawSnapLbl
              ? /^rh(\d+)$/i.test(rawSnapLbl)
                ? `R${rawSnapLbl.slice(2)}`
                : rawSnapLbl
              : `R${Math.max(1, snap.timerId - 1)}`;
            const snapHost = snap.endpoint.split(":")[0] || "192.168.1.101";
            const snapPort = Number(snap.endpoint.split(":")[1]) || DEFAULT_RH_PORT;
            const authBadge = !snap.connected
              ? `<span class="badge">Offline</span>`
              : !snap.authKnown
                ? `<span class="badge">Auth pending</span>`
                : snap.authOk
                  ? `<span class="badge badge-good">Auth OK</span>`
                  : `<span class="badge badge-warn" title="Sign in with admin credentials to tune frequencies and arm gates">Guest (Read-only)</span>`;
            const serverText = !snap.connected
              ? "—"
              : `${snap.serverVersion ? `v${snap.serverVersion}` : "Connected"}${snap.authKnown ? (snap.authOk ? " · Admin" : " · Guest") : ""}`;
            const gateText = !snap.connected ? "Offline" : snap.gateArmed ? "Armed" : "Standby";
            const clkText = !snap.connected
              ? "—"
              : snap.clockSynced
                ? `Synced (${Math.abs(snap.clockOffsetMs) < 0.5 ? "<1" : snap.clockOffsetMs.toFixed(1)} ms RTT)`
                : "Syncing…";

            const isPromptOpenOnCard = Boolean(
              cardPrompt &&
                (cardPrompt.timerId === snap.timerId ||
                  (cardPrompt.host === snapHost && cardPrompt.port === snapPort))
            );
            const cardCredsBar = isPromptOpenOnCard
              ? this.renderRhInlineCredsBar(`Credentials for ${snapLabel} (${snap.endpoint})`)
              : "";

            const barsHtml = Array.from({ length: nodeCount }, (_, idx) => {
              const freq = snap.nodeFreqsMhz?.[idx] ?? 0;
              const active = freq > 0;
              const val = snap.slotRssi?.[idx] ?? 0;
              const crossing = Boolean(snap.crossingFlag?.[idx]);
              const valid = Boolean(active && snap.connected && val > 0);
              const widthPct = valid ? pctRssi(val) : 0;
              const enterLvl = snap.nodeEnterLevels?.[idx] || 95;
              const exitLvl = snap.nodeExitLevels?.[idx] || 70;
              const enterPct = pctRssi(enterLvl);
              const exitPct = pctRssi(exitLvl);
              const labelHtml = active
                ? `<span class="debug-ch-inline" style="background:#94a3b8"></span><strong>Node ${idx + 1}</strong> <span class="muted mono">${esc(formatHardwareFreq(freq))}</span>`
                : `<span class="debug-ch-inline" style="background:transparent;box-shadow:inset 0 0 0 1.5px #64748b"></span><strong>Node ${idx + 1}</strong> <span class="muted">Disabled</span>`;
              const isCross = Boolean(active && snap.connected && crossing);
              const valStr = !active
                ? ""
                : !snap.connected
                  ? "—"
                  : `${Math.round(val)}`;
              const isNumVal = Boolean(active && snap.connected);

              return `
                <div class="debug-net-inspector-bar-row net-node-bar-row ${active ? "" : "is-muted"}">
                  <span class="net-node-bar-label">${labelHtml}</span>
                  <div class="debug-bar-track" style="position:relative">
                    <span class="debug-bar-fill" data-rh-bar-fill="${idx}" style="width:${widthPct.toFixed(1)}%"></span>
                    ${
                      active
                        ? `<span title="Exit threshold ${Math.round(exitLvl)}" style="position:absolute;top:-2px;bottom:-2px;left:${exitPct.toFixed(1)}%;width:2px;background:rgba(250,204,21,0.65);pointer-events:none"></span>
                           <span title="Enter threshold ${Math.round(enterLvl)}" style="position:absolute;top:-2px;bottom:-2px;left:${enterPct.toFixed(1)}%;width:2px;background:rgba(163,230,53,0.9);pointer-events:none"></span>
                           <span class="net-node-crossing-tag mono" data-rh-bar-cross="${idx}" ${isCross ? "" : "hidden"}>${isCross ? "CROSSING" : ""}</span>`
                        : ""
                    }
                  </div>
                  <span class="net-node-bar-val ${isNumVal ? "mono" : ""} ${isCross ? "is-crossing" : ""}" data-rh-bar-val="${idx}">${valStr}</span>
                </div>`;
            }).join("");

            return `
              <div class="card card-flush" data-rh-card="${snap.timerId}">
                <div class="net-device-card-head">
                  <span class="debug-led-status">
                    <span class="timer-color-dot ${snap.connected ? "is-live" : "is-off"}" style="--c:${esc(color)}" title="${snap.connected ? "Connected" : "Disconnected"}"></span>
                    <span class="debug-head-note">
                      <strong>${esc(snapLabel)}</strong> · <span class="mono">${esc(snap.endpoint)}</span>
                    </span>
                  </span>
                  <div class="debug-connect-actions">
                    ${authBadge}
                    <span class="badge">${nodeCount} nodes</span>
                    <span class="badge">${assignedGate ? esc(assignedGate) : "Unassigned"}</span>
                    <button class="btn btn-sm btn-ghost" type="button" data-action="rh-open-device-creds" data-cred-scope="card" data-host="${esc(snapHost)}" data-port="${snapPort}" data-label="${esc(snapLabel)}" data-timer-id="${snap.timerId}" ${this.rhBusy ? "disabled" : ""}>
                      ${!snap.connected ? "Reconnect…" : !snap.authOk ? "Sign in…" : "Credentials"}
                    </button>
                    ${
                      snap.connected
                        ? `<button class="btn btn-sm btn-ghost" type="button" data-action="rh-disconnect" data-timer-id="${snap.timerId}">
                            Disconnect
                          </button>`
                        : ""
                    }
                  </div>
                </div>
                ${cardCredsBar}

                <div class="debug-net-inspector-kpis net-device-card-kpis">
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Server &amp; Auth</span>
                    <strong class="debug-net-inspector-kpi-val">${esc(serverText)}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Gate state</span>
                    <strong class="debug-net-inspector-kpi-val" data-rh-kpi="gate-state">${gateText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Clock sync</span>
                    <strong class="debug-net-inspector-kpi-val mono" data-rh-kpi="clock">${clkText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Track position</span>
                    <strong class="debug-net-inspector-kpi-val">${assignedGate ? esc(assignedGate) : `<span class="note">Off track</span>`}</strong>
                  </div>
                </div>

                <div class="net-device-card-body">
                  <div class="debug-subbox">
                    <div class="debug-net-inspector-bars-wrap">
                      <div class="debug-subbar">
                        <span class="debug-chart-title">${nodeCount}-node receiver RSSI (0–255 scale)</span>
                        <span class="note">Yellow tick = Exit · Green tick = Enter</span>
                      </div>
                      <div class="debug-net-inspector-bars">${barsHtml}</div>
                    </div>
                  </div>
                </div>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  private async refreshRhUsbPorts(): Promise<void> {
    if (this.rhUsbRefreshing) return;
    this.rhUsbRefreshing = true;
    this.lastRhUsbConnSig = "";
    this.renderAll();
    try {
      this.rhUsbPorts = await sharedRHLink.listUSBPorts(this.store, this.rhUsbShowAllPorts);
      this.rhUsbLoadedOnce = true;
    } catch (err) {
      this.rhError = err instanceof Error ? err.message : String(err);
    } finally {
      this.rhUsbRefreshing = false;
      this.lastRhUsbConnSig = "";
      this.renderAll();
    }
  }

  private renderRotorHazardUSBView(): void {
    const connHost = this.slot("rh-usb-connection");
    const timersHost = this.slot("rh-usb-timers");
    const snaps = sharedRHLink.snapshots(this.store);
    const errText = this.rhError || sharedRHLink.errorMessage || "";
    const isSim = this.store.simulatorRunning;

    if (!isSim && !this.rhUsbLoadedOnce && !this.rhUsbRefreshing && capabilitiesSnapshot().portable) {
      this.rhUsbLoadedOnce = true;
      void this.refreshRhUsbPorts();
    }

    const ports: RHUSBPortInfo[] = isSim
      ? (this.store.simState?.rotorhazardUnits ?? [])
          .filter((u) => u.poweredOn)
          .map((u, idx) => {
            const pName = u.portName?.trim() || `SIM-RH-USB${idx + 1}`;
            const rawLbl = u.label?.trim() || "";
            const normLbl = rawLbl
              ? /^rh(\d+)$/i.test(rawLbl)
                ? `R${rawLbl.slice(2)}`
                : rawLbl
              : `R${Math.max(1, u.timerId - 1)}`;
            return {
              name: pName,
              isUsb: true,
              product: `Simulated RotorHazard USB (${u.nodeCount === 4 ? 4 : 8} nodes)`,
              label: normLbl,
              timerId: u.timerId,
              nodeCount: u.nodeCount === 4 ? 4 : 8,
              baudRate: u.baudRate || 115200,
              apiLevel: u.apiLevel || 36,
              connected: Boolean(u.poweredOn && u.connected),
            };
          })
      : this.rhUsbPorts;

    const connectedPortNames = new Set(
      snaps.filter((s) => s.connected).map((s) => (s.portName || s.endpoint).toUpperCase())
    );
    const connectedByPortName = new Map(
      snaps
        .filter((s) => s.connected)
        .map((s) => [(s.portName || s.endpoint).toUpperCase(), s] as const)
    );
    if (!this.rhUsbSelectedPort || !ports.some((p) => p.name === this.rhUsbSelectedPort)) {
      const firstConnected = ports.find((p) => connectedPortNames.has(p.name.toUpperCase()));
      this.rhUsbSelectedPort = firstConnected?.name ?? ports[0]?.name ?? "";
    }

    const activeEl = document.activeElement as HTMLElement | null;
    const focusedInsideConn = Boolean(
      activeEl && connHost.contains(activeEl) && (activeEl.tagName === "SELECT" || activeEl.tagName === "INPUT")
    );

    const connSig = JSON.stringify({
      sim: isSim,
      busy: this.rhBusy,
      refreshing: this.rhUsbRefreshing,
      allPorts: this.rhUsbShowAllPorts,
      selPort: this.rhUsbSelectedPort,
      baud: this.rhUsbBaudRate,
      err: errText,
      connTimers: snaps.filter((s) => s.connected).map((s) => `${s.timerId}:${s.portName || s.endpoint}`),
      ports: ports.map((p) => ({
        n: p.name,
        p: p.product,
        l: p.label,
        c: connectedPortNames.has(p.name.toUpperCase()),
      })),
    });

    if (!focusedInsideConn && connSig !== this.lastRhUsbConnSig) {
      this.lastRhUsbConnSig = connSig;
      const selectedConnSnap = this.rhUsbSelectedPort
        ? connectedByPortName.get(this.rhUsbSelectedPort.toUpperCase())
        : undefined;
      const selectedAlreadyConnected = Boolean(selectedConnSnap);
      const formatCompactPortName = (name: string): string => {
        const trimmed = name.trim();
        const androidUsb = /^\/dev\/bus\/usb\/(\d+)\/(\d+)(#\d+)?$/i.exec(trimmed);
        if (androidUsb) {
          return `USB ${androidUsb[1]}/${androidUsb[2]}${androidUsb[3] ?? ""}`;
        }
        return trimmed.replace(/^\/dev\//, "");
      };
      const formatCompactProduct = (product?: string): string => {
        const raw = (product ?? "").trim();
        if (!raw) return "";
        if (/esp32[-\s]?c5|seeed\s+xiao|usb\s+jtag/i.test(raw)) {
          return "ESP32-C5";
        }
        return raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      };
      const portOptionsHtml =
        ports.length > 0
          ? ports
              .map((p) => {
                const isConn = connectedPortNames.has(p.name.toUpperCase());
                const shortName = formatCompactPortName(p.name);
                const shortProd = formatCompactProduct(p.product);
                const desc = p.label
                  ? `${shortName} · ${p.label} (${p.nodeCount ?? 8} nodes)`
                  : shortProd
                    ? `${shortName} · ${shortProd}`
                    : shortName;
                return `<option value="${esc(p.name)}" ${p.name === this.rhUsbSelectedPort ? "selected" : ""}>${esc(desc)}${isConn ? " (Connected)" : ""}</option>`;
              })
              .join("")
          : `<option value="">${isSim ? "No powered-on simulated USB devices" : "No USB serial ports detected"}</option>`;

      connHost.innerHTML = `
        <div class="card card-flush">
          <div class="rh-usb-conn-body">
            <div class="rh-usb-conn-main">
              <div class="rh-usb-conn-fields">
                <label class="rh-usb-conn-field is-port">
                  <span class="muted rh-usb-conn-label">USB Serial Port</span>
                  <select
                    class="input mono rh-usb-conn-select"
                    data-field="rh-usb-port"
                    aria-label="RotorHazard USB serial port"
                    ${ports.length === 0 || this.rhBusy ? "disabled" : ""}
                  >
                    ${portOptionsHtml}
                  </select>
                </label>
                <label class="rh-usb-conn-field is-baud">
                  <span class="muted rh-usb-conn-label">Baud Rate</span>
                  <select
                    class="input mono rh-usb-conn-select"
                    data-field="rh-usb-baud"
                    aria-label="RotorHazard USB baud rate"
                    ${this.rhBusy ? "disabled" : ""}
                  >
                    <option value="0" ${this.rhUsbBaudRate === 0 ? "selected" : ""}>Auto (115200 / 921600)</option>
                    <option value="115200" ${this.rhUsbBaudRate === 115200 ? "selected" : ""}>115200 baud</option>
                    <option value="921600" ${this.rhUsbBaudRate === 921600 ? "selected" : ""}>921600 baud (STM32)</option>
                  </select>
                </label>
              </div>
              <div class="rh-usb-conn-actions">
                ${
                  selectedAlreadyConnected && selectedConnSnap
                    ? `<button
                        class="btn btn-ghost"
                        type="button"
                        data-action="rh-disconnect"
                        data-timer-id="${selectedConnSnap.timerId}"
                        ${this.rhBusy ? "disabled" : ""}
                      >
                        ${icons.close(14)}<span>Disconnect</span>
                      </button>`
                    : `<button
                        class="btn btn-armed"
                        type="button"
                        data-action="rh-usb-connect"
                        ${this.rhBusy || !this.rhUsbSelectedPort ? "disabled" : ""}
                      >
                        ${icons.plug(14)}<span>${this.rhBusy ? "Connecting…" : "Connect USB"}</span>
                      </button>`
                }
                <button
                  class="btn btn-ghost"
                  type="button"
                  data-action="rh-usb-refresh"
                  ${this.rhUsbRefreshing || this.rhBusy ? "disabled" : ""}
                  title="Refresh available USB serial ports"
                >
                  ${icons.reset(14)}<span>${this.rhUsbRefreshing ? "Refreshing…" : "Refresh Ports"}</span>
                </button>
              </div>
            </div>
            <div class="rh-usb-conn-foot">
              ${
                !isSim
                  ? `<label class="rh-usb-conn-toggle">
                      <input type="checkbox" data-field="rh-usb-all-ports" ${this.rhUsbShowAllPorts ? "checked" : ""} />
                      <span class="note">Show all serial ports</span>
                    </label>`
                  : `<span class="note">Direct binary serial link · no LAN IP or admin login required</span>`
              }
            </div>
          </div>
          ${errText ? `<div class="sim-error-note" style="margin:0 16px 12px">${esc(errText)}</div>` : ""}
        </div>`;
    }

    const gateByTimer = new Map<number, { gateId: number; label: string }>();
    for (const g of this.store.nodes) {
      if (g.assignedTimerId > 0) {
        gateByTimer.set(g.assignedTimerId, {
          gateId: g.gateId,
          label: `Track #${g.trackOrder + 1}${g.role === "START_FINISH" ? " (Start)" : ""}`,
        });
      }
    }

    const pctRssi = (val: number) => Math.max(0, Math.min(100, (val / 255) * 100));
    const structSig = JSON.stringify({
      snaps: snaps.map((s) => {
        const gMeta = gateByTimer.get(s.timerId);
        return {
          id: s.timerId,
          label: s.label,
          ep: s.portName || s.endpoint,
          baud: s.baudRate || 115200,
          api: s.apiLevel || 36,
          conn: s.connected,
          ver: s.serverVersion,
          nodes: s.nodeCount,
          gate: gMeta?.label || "",
          freqs: s.nodeFreqsMhz ?? [],
          enters: s.nodeEnterLevels ?? [],
          exits: s.nodeExitLevels ?? [],
        };
      }),
    });

    if (structSig === this.lastRhUsbTimersStructSig && snaps.length > 0) {
      for (const snap of snaps) {
        const card = timersHost.querySelector<HTMLElement>(`[data-rh-usb-card="${snap.timerId}"]`);
        if (!card) continue;
        const gateEl = card.querySelector<HTMLElement>('[data-rh-kpi="gate-state"]');
        const gateText = !snap.connected ? "Offline" : snap.gateArmed ? "Armed" : "Standby";
        if (gateEl && gateEl.textContent !== gateText) gateEl.textContent = gateText;

        const clkEl = card.querySelector<HTMLElement>('[data-rh-kpi="clock"]');
        const clkText = !snap.connected
          ? "—"
          : snap.clockSynced
            ? `Synced (${Math.abs(snap.clockOffsetMs) < 0.5 ? "<1" : snap.clockOffsetMs.toFixed(1)} ms RTT)`
            : "Syncing…";
        if (clkEl && clkEl.textContent !== clkText) clkEl.textContent = clkText;

        const nodeCount = Math.max(1, Math.min(8, snap.nodeCount || 8));
        for (let idx = 0; idx < nodeCount; idx++) {
          const freq = snap.nodeFreqsMhz?.[idx] ?? 0;
          const active = freq > 0;
          const val = snap.slotRssi?.[idx] ?? 0;
          const crossing = Boolean(snap.crossingFlag?.[idx]);
          const valid = Boolean(active && snap.connected && val > 0);
          const widthStr = `${(valid ? pctRssi(val) : 0).toFixed(1)}%`;
          const isCross = Boolean(active && snap.connected && crossing);
          const valStr = !active ? "" : !snap.connected ? "—" : `${Math.round(val)}`;
          const fillEl = card.querySelector<HTMLElement>(`[data-rh-bar-fill="${idx}"]`);
          if (fillEl && fillEl.style.width !== widthStr) fillEl.style.width = widthStr;
          const crossEl = card.querySelector<HTMLElement>(`[data-rh-bar-cross="${idx}"]`);
          if (crossEl) {
            const wantCross = isCross ? "CROSSING" : "";
            if (crossEl.textContent !== wantCross) crossEl.textContent = wantCross;
            crossEl.hidden = !isCross;
          }
          const valEl = card.querySelector<HTMLElement>(`[data-rh-bar-val="${idx}"]`);
          if (valEl) {
            if (valEl.textContent !== valStr) valEl.textContent = valStr;
            valEl.classList.toggle("mono", Boolean(active && snap.connected));
            valEl.classList.toggle("is-crossing", isCross);
          }
        }
      }
      return;
    }

    this.lastRhUsbTimersStructSig = structSig;

    if (snaps.length === 0) {
      timersHost.innerHTML = `
        <div class="card empty-note" style="padding:18px">
          No RotorHazard USB devices connected yet. Select a USB serial port above and click <strong>Connect USB</strong>.
        </div>`;
      return;
    }

    timersHost.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        ${snaps
          .map((snap) => {
            const color = timerColor(this.store, snap.timerId);
            const gMeta = gateByTimer.get(snap.timerId);
            const assignedGate = gMeta?.label;
            const nodeCount = Math.max(1, Math.min(8, snap.nodeCount || 8));
            const rawSnapLbl = snap.label?.trim() || "";
            const snapLabel = rawSnapLbl
              ? /^rh(\d+)$/i.test(rawSnapLbl)
                ? `R${rawSnapLbl.slice(2)}`
                : rawSnapLbl
              : `R${Math.max(1, snap.timerId - 1)}`;
            const portStr = snap.portName || snap.endpoint;
            const apiLvl = snap.apiLevel || 36;
            const baudRate = snap.baudRate || 115200;
            const protoText = !snap.connected ? "—" : `API ${apiLvl} · ${baudRate} baud`;
            const gateText = !snap.connected ? "Offline" : snap.gateArmed ? "Armed" : "Standby";
            const clkText = !snap.connected
              ? "—"
              : snap.clockSynced
                ? `Synced (${Math.abs(snap.clockOffsetMs) < 0.5 ? "<1" : snap.clockOffsetMs.toFixed(1)} ms RTT)`
                : "Syncing…";

            const barsHtml = Array.from({ length: nodeCount }, (_, idx) => {
              const freq = snap.nodeFreqsMhz?.[idx] ?? 0;
              const active = freq > 0;
              const val = snap.slotRssi?.[idx] ?? 0;
              const crossing = Boolean(snap.crossingFlag?.[idx]);
              const valid = Boolean(active && snap.connected && val > 0);
              const widthPct = valid ? pctRssi(val) : 0;
              const enterLvl = snap.nodeEnterLevels?.[idx] || 95;
              const exitLvl = snap.nodeExitLevels?.[idx] || 70;
              const enterPct = pctRssi(enterLvl);
              const exitPct = pctRssi(exitLvl);
              const labelHtml = active
                ? `<span class="debug-ch-inline" style="background:#94a3b8"></span><strong>Node ${idx + 1}</strong> <span class="muted mono">${esc(formatHardwareFreq(freq))}</span>`
                : `<span class="debug-ch-inline" style="background:transparent;box-shadow:inset 0 0 0 1.5px #64748b"></span><strong>Node ${idx + 1}</strong> <span class="muted">Disabled</span>`;
              const isCross = Boolean(active && snap.connected && crossing);
              const valStr = !active ? "" : !snap.connected ? "-" : `${Math.round(val)}`;
              const isNumVal = Boolean(active && snap.connected);

              return `
                <div class="debug-net-inspector-bar-row net-node-bar-row ${active ? "" : "is-muted"}">
                  <span class="net-node-bar-label">${labelHtml}</span>
                  <div class="debug-bar-track" style="position:relative">
                    <span class="debug-bar-fill" data-rh-bar-fill="${idx}" style="width:${widthPct.toFixed(1)}%"></span>
                    ${
                      active
                        ? `<span title="Exit threshold ${Math.round(exitLvl)}" style="position:absolute;top:-2px;bottom:-2px;left:${exitPct.toFixed(1)}%;width:2px;background:rgba(250,204,21,0.65);pointer-events:none"></span>
                           <span title="Enter threshold ${Math.round(enterLvl)}" style="position:absolute;top:-2px;bottom:-2px;left:${enterPct.toFixed(1)}%;width:2px;background:rgba(163,230,53,0.9);pointer-events:none"></span>
                           <span class="net-node-crossing-tag mono" data-rh-bar-cross="${idx}" ${isCross ? "" : "hidden"}>${isCross ? "CROSSING" : ""}</span>`
                        : ""
                    }
                  </div>
                  <span class="net-node-bar-val ${isNumVal ? "mono" : ""} ${isCross ? "is-crossing" : ""}" data-rh-bar-val="${idx}">${valStr}</span>
                </div>`;
            }).join("");

            return `
              <div class="card card-flush" data-rh-usb-card="${snap.timerId}">
                <div class="net-device-card-head">
                  <span class="debug-led-status">
                    <span class="timer-color-dot ${snap.connected ? "is-live" : "is-off"}" style="--c:${esc(color)}" title="${snap.connected ? "Connected" : "Disconnected"}"></span>
                    <span class="debug-head-note">
                      <strong>${esc(snapLabel)}</strong> · <span class="mono">${esc(portStr)}</span>
                    </span>
                  </span>
                  <div class="debug-connect-actions">
                    ${snap.connected ? `<span class="badge badge-good mono">API ${apiLvl}</span>` : `<span class="badge">Offline</span>`}
                    <span class="badge">${nodeCount} nodes</span>
                    <span class="badge">${assignedGate ? esc(assignedGate) : "Unassigned"}</span>
                  </div>
                </div>

                <div class="debug-net-inspector-kpis net-device-card-kpis">
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Serial protocol</span>
                    <strong class="debug-net-inspector-kpi-val mono">${esc(protoText)}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Gate state</span>
                    <strong class="debug-net-inspector-kpi-val" data-rh-kpi="gate-state">${gateText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Serial RTT</span>
                    <strong class="debug-net-inspector-kpi-val mono" data-rh-kpi="clock">${clkText}</strong>
                  </div>
                  <div class="debug-net-inspector-kpi">
                    <span class="debug-net-inspector-kpi-label">Track position</span>
                    <strong class="debug-net-inspector-kpi-val">${assignedGate ? esc(assignedGate) : `<span class="note">Off track</span>`}</strong>
                  </div>
                </div>

                <div class="net-device-card-body">
                  <div class="debug-subbox">
                    <div class="debug-net-inspector-bars-wrap">
                      <div class="debug-subbar">
                        <span class="debug-chart-title">${nodeCount}-node receiver RSSI (0-255 scale)</span>
                        <span class="note">Yellow tick = Exit · Green tick = Enter</span>
                      </div>
                      <div class="debug-net-inspector-bars">${barsHtml}</div>
                    </div>
                  </div>
                </div>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  private renderSpokeNodeCard(sp: TopologySpokeInfo, isSelected: boolean): string {
    const slotNum = sp.slot;
    if (!sp.populated) {
      return `
        <button type="button" class="debug-topo-node is-spoke is-empty is-inactive-link ${isSelected ? "is-selected" : ""}" data-action="select-topology-slot" data-slot-num="${slotNum}" aria-pressed="${isSelected}" title="TDMA Slot ${slotNum} (Empty) · click to view slot details">
          <div class="debug-topo-node-head">
            <span class="debug-topo-slot-tag">Slot ${slotNum} · Spoke</span>
            <span class="badge">Empty</span>
          </div>
        </button>`;
    }

    const active = sp.espNowActive;
    const dotClass = active ? "is-spoke" : sp.inHubStatus ? "is-warn" : "";
    const stateBadgeClass = active ? "badge-good" : sp.inHubStatus ? "badge-warn" : "";
    const stateBadgeText = active ? "ESP-NOW Active" : sp.viaUsb ? "USB-C" : sp.inHubStatus ? "Stale" : "Inactive";
    const cardStatusText = active
      ? sp.viaUsb
        ? "Synced via USB-C"
        : "Streaming telemetry"
      : sp.viaUsb
        ? "Connected via USB-C"
        : sp.inHubStatus
          ? "No recent frames"
          : "Inactive · not joined";

    return `
      <button type="button" class="debug-topo-node is-spoke is-populated ${active ? "is-active-link" : "is-inactive-link"} ${isSelected ? "is-selected" : ""}" data-action="select-topology-slot" data-slot-num="${slotNum}" aria-pressed="${isSelected}" title="Click to inspect ${esc(sp.label)} (TDMA Slot ${slotNum})">
        <div class="debug-topo-node-head">
          <span class="debug-topo-slot-tag">Slot ${slotNum} · Spoke${sp.viaUsb ? " · USB" : ""}</span>
          <span class="badge ${stateBadgeClass}">${stateBadgeText}</span>
        </div>
        <div class="debug-topo-node-main">
          <span class="status-dot ${dotClass}"></span>
          <strong class="debug-topo-node-label">${esc(sp.label)}</strong>
          <span class="badge mono">${esc(sp.fp)}</span>
        </div>
        <div class="debug-topo-node-foot">
          <span>${esc(cardStatusText)}</span>
          ${sp.serverGateLabel ? `<span class="mono">${esc(sp.serverGateLabel)}</span>` : `<span class="mono">${esc(sp.fw)}</span>`}
        </div>
      </button>`;
  }

  private renderTopologySection(hub: TopologyHubInfo, spokes: Map<number, TopologySpokeInfo>, selectedSlot: number): void {
    const s = this.activeStatus();
    const populatedSpokes = [...spokes.values()].filter((sp) => sp.populated);
    const activeSpokes = populatedSpokes.filter((sp) => sp.espNowActive);
    const tiedCount = populatedSpokes.length;
    const activeCount = activeSpokes.length;

    let topLed = "";
    let topText = "";
    if (s && s.role === 1) {
      topLed = s.emergencyMode ? "is-emergency" : tiedCount > 0 && activeCount === 0 ? "is-warn" : "is-up";
      topText = s.emergencyMode
        ? `${esc(hub.label)} · Hub (Slot 1) · Emergency mode active (2.4 GHz beacon paused)`
        : `${esc(hub.label)} · Hub (Slot 1) · ${activeCount}/${tiedCount} child Spoke${tiedCount === 1 ? "" : "s"} active on 2.4 GHz Ch ${hub.ch}`;
    } else if (s && s.role === 2) {
      const ownSpoke = spokes.get(s.slot >= 2 ? s.slot : 2);
      topLed = s.emergencyMode ? "is-emergency" : "is-spoke";
      topText = s.emergencyMode
        ? `${esc(s.label || "T1")} · Spoke · Emergency mode active`
        : ownSpoke?.espNowActive
          ? `${esc(s.label || "T1")} · Spoke (Slot ${s.slot}) · Synced to Hub ${esc(hub.label)} on 2.4 GHz Ch ${hub.ch}`
          : `${esc(s.label || "T1")} · Spoke · Searching for Hub sync beacon on 2.4 GHz…`;
    } else if (hub.populated || tiedCount > 0) {
      topLed = activeCount > 0 ? "is-up" : "";
      topText = `Offline preview · click Connect in the top bar for live 2.4 GHz ESP-NOW telemetry`;
    } else {
      topLed = "";
      topText = `Off · click Connect in the top bar to inspect the 2.4 GHz Hub & Spoke topology`;
    }

    const leftSlots = [2, 3, 4].map((n) => spokes.get(n)!);
    const rightSlots = [5, 6, 7].map((n) => spokes.get(n)!);

    const leftCardsHtml = leftSlots.map((sp) => this.renderSpokeNodeCard(sp, selectedSlot === sp.slot)).join("");
    const rightCardsHtml = rightSlots.map((sp) => this.renderSpokeNodeCard(sp, selectedSlot === sp.slot)).join("");

    const leftPaths = [
      { slot: 2, y: 40, d: "M 0 40 C 52 40, 48 120, 100 120" },
      { slot: 3, y: 120, d: "M 0 120 L 100 120" },
      { slot: 4, y: 200, d: "M 0 200 C 52 200, 48 120, 100 120" },
    ]
      .map(({ slot, y, d }) => {
        const sp = spokes.get(slot)!;
        const cls = sp.espNowActive ? "is-active" : sp.populated ? "is-populated" : "is-empty";
        const sel = selectedSlot === slot ? "is-selected" : "";
        return `
          <path class="debug-topo-link ${cls} ${sel}" d="${d}" vector-effect="non-scaling-stroke" />
          <circle class="debug-topo-joint ${cls} ${sel}" cx="3" cy="${y}" r="3.2" />`;
      })
      .join("");

    const rightPaths = [
      { slot: 5, y: 40, d: "M 0 120 C 52 120, 48 40, 100 40" },
      { slot: 6, y: 120, d: "M 0 120 L 100 120" },
      { slot: 7, y: 200, d: "M 0 120 C 52 120, 48 200, 100 200" },
    ]
      .map(({ slot, y, d }) => {
        const sp = spokes.get(slot)!;
        const cls = sp.espNowActive ? "is-active" : sp.populated ? "is-populated" : "is-empty";
        const sel = selectedSlot === slot ? "is-selected" : "";
        return `
          <path class="debug-topo-link ${cls} ${sel}" d="${d}" vector-effect="non-scaling-stroke" />
          <circle class="debug-topo-joint ${cls} ${sel}" cx="97" cy="${y}" r="3.2" />`;
      })
      .join("");

    const isBleHub =
      this.store.timingHardwareMode === "slaprf_ble" ||
      (usbPool.hubConsole() ?? sharedTimerConsole).transportLabel === "Bluetooth";
    const hubSelected = selectedSlot === 1;
    const hubDotClass = hub.emergencyMode ? "is-emergency" : hub.online ? "is-up" : hub.populated ? "is-warn" : "";
    const hubBadgeClass = hub.online ? "badge-good" : hub.populated ? "badge-warn" : "";
    const hubBadgeText = hub.viaUsb
      ? isBleHub
        ? "Bluetooth · Active"
        : "USB-C · Active"
      : hub.online
        ? "Online"
        : hub.populated
          ? "Idle"
          : "Empty";

    const topologyHtml = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${topLed}"></span>
          <span class="debug-head-note">${topText}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge ${hub.online ? "badge-good" : ""}">Hub · Slot 1</span>
          <span class="badge ${activeCount > 0 ? "badge-good" : tiedCount > 0 ? "badge-warn" : ""} mono">${activeCount}/6 Spokes Active</span>
        </div>
      </div>

      <div class="debug-topology-board">
        <div class="debug-topo-col is-spokes-left">
          ${leftCardsHtml}
        </div>

        <svg class="debug-topo-svg is-left" viewBox="0 0 100 240" preserveAspectRatio="none" aria-hidden="true">
          ${leftPaths}
        </svg>

        <div class="debug-topo-col is-hub-center">
          <button type="button" class="debug-topo-node is-hub ${hub.populated ? "is-populated" : "is-empty"} ${hub.online ? "is-active-link" : "is-inactive-link"} ${hubSelected ? "is-selected" : ""}" data-action="select-topology-slot" data-slot-num="1" aria-pressed="${hubSelected}" title="Click to inspect Parent Hub (TDMA Slot 1)">
            <div class="debug-topo-node-head">
              <span class="debug-topo-slot-tag">Slot 1 · Hub</span>
              <span class="badge ${hubBadgeClass}">${hubBadgeText}</span>
            </div>
            ${
              hub.populated
                ? `<div class="debug-topo-node-main">
                    <span class="status-dot ${hubDotClass}"></span>
                    <strong class="debug-topo-node-label">${esc(hub.label)}</strong>
                    ${hub.fp && hub.fp !== "—" ? `<span class="badge mono">${esc(hub.fp)}</span>` : ""}
                  </div>
                  <div class="debug-topo-node-foot">
                    <span>${esc(hub.statusNote)}</span>
                    <span class="mono">Ch ${hub.ch} · ${activeCount}/${tiedCount} active</span>
                  </div>`
                : ""
            }
          </button>
        </div>

        <svg class="debug-topo-svg is-right" viewBox="0 0 100 240" preserveAspectRatio="none" aria-hidden="true">
          ${rightPaths}
        </svg>

        <div class="debug-topo-col is-spokes-right">
          ${rightCardsHtml}
        </div>
      </div>

      <div class="debug-topology-legend">
        <span class="debug-topo-legend-item"><span class="debug-topo-legend-line is-solid"></span><span>Solid = ESP-NOW active</span></span>
        <span class="debug-topo-legend-item"><span class="debug-topo-legend-line is-dashed"></span><span>Dashed = Inactive / empty slot</span></span>
        <span class="note">Click the center Hub or any Spoke slot to inspect its details below.</span>
      </div>

      ${this.renderMobileTopologyGraph(hub, populatedSpokes, selectedSlot)}`;

    const topoStructKey = [
      topLed,
      topText,
      selectedSlot,
      hub.populated ? "1" : "0",
      hub.online ? "1" : "0",
      hub.emergencyMode ? "1" : "0",
      hub.viaUsb ? "1" : "0",
      hub.label,
      hub.fp,
      hub.ch,
      hub.statusNote,
      ...[2, 3, 4, 5, 6, 7].map((n) => {
        const sp = spokes.get(n)!;
        return `${n}:${sp.populated ? 1 : 0}:${sp.espNowActive ? 1 : 0}:${sp.inHubStatus ? 1 : 0}:${sp.viaUsb ? 1 : 0}:${sp.label}:${sp.fp}:${sp.fw}:${sp.serverGateLabel ?? ""}`;
      }),
    ].join("|");

    const topoHost = this.slot("topology");
    if (topoStructKey === this.lastTopologyStructKey && topoHost.querySelector("[data-mobile-topology-graph]")) {
      for (const sp of populatedSpokes) {
        const rateEl = topoHost.querySelector<HTMLElement>(`[data-mnode-rate="${sp.slot}"]`);
        if (rateEl) {
          const nextNum = String(Math.min(999, Math.max(1, Math.round(sp.ratePktPerSec))));
          if (rateEl.textContent !== nextNum) {
            rateEl.textContent = nextNum;
          }
        }
      }
      return;
    }

    this.lastTopologyStructKey = topoStructKey;
    if (topologyHtml !== this.lastTopologyHtml) {
      this.lastTopologyHtml = topologyHtml;
      topoHost.innerHTML = topologyHtml;
    }
  }

  /**
   * Compact visual Hub-and-Spoke graph for mobile viewports (`<= 860px`):
   * - Always shows the Hub (Slot 1), even when disconnected/empty.
   * - Only shows connected/populated Spokes (`populated === true`), hiding empty slots so users
   *   never see or accidentally select phantom empty slots on a phone screen.
   */
  private renderMobileTopologyGraph(
    hub: TopologyHubInfo,
    populatedSpokes: TopologySpokeInfo[],
    selectedSlot: number
  ): string {
    const n = populatedSpokes.length;
    const W = 320;
    let H = 104;
    let hubPt = { x: 160, y: 38 };
    let spokePts: Array<{ x: number; y: number }> = [];
    let curveDir: "horiz" | "vert" = "horiz";

    if (n === 1) {
      H = 92;
      hubPt = { x: 86, y: 46 };
      spokePts = [{ x: 234, y: 46 }];
      curveDir = "horiz";
    } else if (n === 2) {
      H = 148;
      hubPt = { x: 160, y: 34 };
      spokePts = [
        { x: 88, y: 114 },
        { x: 232, y: 114 },
      ];
      curveDir = "vert";
    } else if (n === 3) {
      H = 154;
      hubPt = { x: 160, y: 34 };
      spokePts = [
        { x: 54, y: 118 },
        { x: 160, y: 118 },
        { x: 266, y: 118 },
      ];
      curveDir = "vert";
    } else if (n === 4) {
      H = 166;
      hubPt = { x: 160, y: 83 };
      spokePts = [
        { x: 52, y: 44 },
        { x: 52, y: 122 },
        { x: 268, y: 44 },
        { x: 268, y: 122 },
      ];
      curveDir = "horiz";
    } else if (n === 5) {
      H = 212;
      hubPt = { x: 160, y: 106 };
      spokePts = [
        { x: 52, y: 36 },
        { x: 52, y: 106 },
        { x: 52, y: 176 },
        { x: 268, y: 66 },
        { x: 268, y: 146 },
      ];
      curveDir = "horiz";
    } else if (n >= 6) {
      H = 212;
      hubPt = { x: 160, y: 106 };
      spokePts = [
        { x: 52, y: 36 },
        { x: 52, y: 106 },
        { x: 52, y: 176 },
        { x: 268, y: 36 },
        { x: 268, y: 106 },
        { x: 268, y: 176 },
      ];
      curveDir = "horiz";
    }

    const svgPathsHtml = populatedSpokes
      .slice(0, 6)
      .map((sp, idx) => {
        const pt = spokePts[idx];
        const cls = sp.espNowActive ? "is-active" : "is-populated";
        const sel = selectedSlot === sp.slot ? "is-selected" : "";
        let d: string;
        if (n === 1) {
          d = `M ${hubPt.x} ${hubPt.y} L ${pt.x} ${pt.y}`;
        } else if (curveDir === "vert") {
          const cy1 = hubPt.y + (pt.y - hubPt.y) * 0.54;
          const cy2 = hubPt.y + (pt.y - hubPt.y) * 0.46;
          d = `M ${hubPt.x} ${hubPt.y} C ${hubPt.x} ${cy1.toFixed(1)}, ${pt.x} ${cy2.toFixed(1)}, ${pt.x} ${pt.y}`;
        } else {
          const mx = (pt.x + hubPt.x) * 0.5;
          d = `M ${pt.x} ${pt.y} C ${mx.toFixed(1)} ${pt.y}, ${mx.toFixed(1)} ${hubPt.y}, ${hubPt.x} ${hubPt.y}`;
        }
        const midX = (hubPt.x + pt.x) * 0.5;
        const midY = (hubPt.y + pt.y) * 0.5;
        return `
          <path class="debug-topo-link ${cls} ${sel}" d="${d}" vector-effect="non-scaling-stroke" />
          <circle class="debug-topo-joint ${cls} ${sel}" cx="${midX.toFixed(1)}" cy="${midY.toFixed(1)}" r="2.8" />`;
      })
      .join("");

    const isBleHub =
      this.store.timingHardwareMode === "slaprf_ble" ||
      (usbPool.hubConsole() ?? sharedTimerConsole).transportLabel === "Bluetooth";
    const hubSelected = selectedSlot === 1;
    const hubDotClass = hub.emergencyMode ? "is-emergency" : hub.online ? "is-up" : hub.populated ? "is-warn" : "";
    const hubTitle = hub.populated && hub.label ? hub.label : "Hub";
    const hubSub = hub.emergencyMode
      ? "Emergency"
      : hub.viaUsb
        ? isBleHub
          ? `BLE · Ch ${hub.ch}`
          : `USB · Ch ${hub.ch}`
        : hub.online
          ? `Ch ${hub.ch} · Sync`
          : hub.populated
            ? "Idle"
            : "Empty";

    const hubNodeHtml = `
      <button
        type="button"
        class="net-mnode is-hub ${hub.populated ? "is-populated" : "is-empty"} ${hub.online ? "is-active-link" : "is-inactive-link"} ${hubSelected ? "is-selected" : ""}"
        style="left:${((hubPt.x / W) * 100).toFixed(2)}%;top:${((hubPt.y / H) * 100).toFixed(2)}%"
        data-action="select-topology-slot"
        data-slot-num="1"
        aria-pressed="${hubSelected}"
        title="Inspect Hub (Slot 1)"
      >
        <span class="net-mnode-main">
          <span class="status-dot ${hubDotClass}"></span>
          <strong class="net-mnode-title">${esc(hubTitle)}</strong>
        </span>
        <span class="net-mnode-sub mono">${esc(hubSub)}</span>
      </button>`;

    const spokeNodesHtml = populatedSpokes
      .slice(0, 6)
      .map((sp, idx) => {
        const pt = spokePts[idx];
        const isSel = selectedSlot === sp.slot;
        const active = sp.espNowActive;
        const dotClass = active ? "is-spoke" : sp.inHubStatus ? "is-warn" : "";
        const spTitle = sp.label || `S${sp.slot}`;
        const spSubHtml = active
          ? sp.viaUsb
            ? "USB-C"
            : `<span class="net-metric-pair"><span class="net-num-slot is-int3" data-mnode-rate="${sp.slot}">${Math.min(999, Math.max(1, Math.round(sp.ratePktPerSec)))}</span> <span>pkt/s</span></span>`
          : sp.viaUsb
            ? "USB-C"
            : "Stale";
        return `
          <button
            type="button"
            class="net-mnode is-spoke is-populated ${active ? "is-active-link" : "is-inactive-link"} ${isSel ? "is-selected" : ""}"
            style="left:${((pt.x / W) * 100).toFixed(2)}%;top:${((pt.y / H) * 100).toFixed(2)}%"
            data-action="select-topology-slot"
            data-slot-num="${sp.slot}"
            aria-pressed="${isSel}"
            title="Inspect ${esc(spTitle)} (Slot ${sp.slot})"
          >
            <span class="net-mnode-main">
              <span class="status-dot ${dotClass}"></span>
              <strong class="net-mnode-title">${esc(spTitle)}</strong>
            </span>
            <span class="net-mnode-sub mono">${spSubHtml}</span>
          </button>`;
      })
      .join("");

    const footNote =
      n === 0
        ? hub.online
          ? "No Spokes linked yet · powered-on Spokes appear here automatically."
          : isBleHub
            ? "Connect Hub H1 over Bluetooth to view linked Spokes."
            : "Connect Hub H1 over USB-C to view linked Spokes."
        : "Tap Hub or any Spoke node to inspect it below.";

    return `
      <div class="net-mobile-graph" data-mobile-topology-graph>
        <div class="net-mobile-graph-stage" style="height:${H}px">
          <svg class="net-mobile-graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            ${svgPathsHtml}
          </svg>
          ${hubNodeHtml}
          ${spokeNodesHtml}
        </div>
        <div class="net-mobile-graph-foot">
          <span class="note">${esc(footNote)}</span>
        </div>
      </div>`;
  }

  private renderRssiBars(dbmSource: number[] | null | undefined, sourceLabel: string, titleText: string): string {
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    const specs = this.visibleBarSpecs();
    const isLight = getAppTheme() === "light";
    const activeCount = specs.filter((b) => this.signalEnabledCh[b.idx]).length;
    const raceActive = this.isLiveRaceHeatActive();

    const barsBodyHtml =
      specs.length === 0
        ? `<p class="note">No active pilot channels in the current session. Enable pilots on <strong>Pilots</strong> or switch to <strong>All Raceband</strong> above.</p>`
        : `<div class="debug-net-inspector-bars">
            ${specs
              .map(({ idx, mhz, pilot }) => {
                const band = racebandName(mhz) || formatHardwareFreq(mhz) || `Ch${idx + 1}`;
                const col = channelColor(idx);
                const onCh = Boolean(this.signalEnabledCh[idx]);
                const dotGlow = isLight ? "0 0 0 1px rgba(15, 23, 42, 0.2)" : `0 0 7px ${col}`;
                const val = dbmSource ? dbmSource[idx] : undefined;
                const valid = onCh && val !== undefined && val > -127 && val < 0;
                const widthPct = valid ? pct(val!) : 0;
                const title = `Click to toggle ${band} (${mhz} MHz${pilot ? ` · ${pilot}` : ""}) monitoring on/off · double-click to solo`;
                return `
                  <div class="debug-net-inspector-bar-row is-interactive ${onCh ? "" : "is-muted"}" data-bar-row="${idx}" data-action="net-signal-ch" data-ch="${idx}" role="button" tabindex="0" aria-pressed="${onCh}" title="${esc(title)}">
                    <span class="debug-bar-label net-ch-bar-label mono"><span class="debug-ch-inline" data-bar-dot style="${onCh ? `background:${col};box-shadow:${dotGlow}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col}`}"></span><strong>${esc(band)}</strong> ${mhz}</span>
                    <div class="debug-bar-track">
                      <span class="debug-bar-fill" data-bar-fill="${idx}" style="width:${widthPct.toFixed(1)}%"></span>
                    </div>
                    <span class="debug-bar-value mono" data-bar-val="${idx}">${!onCh ? "Off" : valid ? `${val!.toFixed(1)} dBm` : "—"}</span>
                  </div>`;
              })
              .join("")}
          </div>`;

    const rightMetaHtml = this.surveyError
      ? `<span class="note debug-tone-bad">${esc(this.surveyError)}</span>`
      : this.surveyAllRaceband
        ? `<span class="note">Lap detection paused · <span class="mono" data-net-bar-source>${esc(sourceLabel)}</span></span>`
        : `<span class="note mono" data-net-bar-source>${esc(sourceLabel)}</span>`;

    return `
      <div class="debug-net-inspector-bars-wrap" data-net-bars>
        <div class="debug-subbox-head debug-net-bars-head">
          <span class="debug-subbox-title is-active">${icons.signal(14)}<span>${titleText}</span></span>
          <div class="segmented debug-net-scope-seg" role="group" aria-label="Measured channels">
            <button type="button" class="${!this.surveyAllRaceband ? "is-active" : ""}" data-action="set-channel-scope" data-scope="pilots" title="Measure only the active pilots' channels (default)">Pilot channels</button>
            <button type="button" class="${this.surveyAllRaceband ? "is-active" : ""}" data-action="set-channel-scope" data-scope="raceband" ${raceActive && !this.surveyAllRaceband ? "disabled" : ""} title="${raceActive ? "Unavailable while a race heat is running" : "Temporarily measure all 8 Raceband channels (R1–R8) across Hub and Spokes"}">All Raceband</button>
          </div>
        </div>
        <div class="debug-subbar debug-net-bars-subbar">
          ${
            specs.length > 0
              ? `<span class="note debug-live-ch-hint" data-net-ch-note><span class="mono">${activeCount}/${specs.length}</span> active · click row to toggle · double-click to solo</span>`
              : `<span class="note">0 active</span>`
          }
          ${rightMetaHtml}
        </div>
        ${barsBodyHtml}
      </div>`;
  }

  private patchTimerLiveValues(
    host: HTMLElement,
    opts: {
      rateHtml: string;
      framesHtml: string;
      kpiFramesHtml: string;
      lastFrameHtml: string;
      seqText: string;
      trackPosHtml: string;
      kvTrackPosHtml?: string;
      sourceLabel: string;
      dbmSource: number[] | null | undefined;
    }
  ): boolean {
    if (!host.querySelector("[data-net-bars]")) {
      return false;
    }
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    const topRate = host.querySelector<HTMLElement>("[data-net-top-rate]");
    if (topRate && topRate.innerHTML !== opts.rateHtml) topRate.innerHTML = opts.rateHtml;
    const topFrames = host.querySelector<HTMLElement>("[data-net-top-frames]");
    if (topFrames && topFrames.innerHTML !== opts.framesHtml) topFrames.innerHTML = opts.framesHtml;

    const kpiFrames = host.querySelector<HTMLElement>('[data-net-kpi="frames"]');
    if (kpiFrames && kpiFrames.innerHTML !== opts.kpiFramesHtml) kpiFrames.innerHTML = opts.kpiFramesHtml;
    const kpiLast = host.querySelector<HTMLElement>('[data-net-kpi="last-frame"]');
    if (kpiLast && kpiLast.innerHTML !== opts.lastFrameHtml) kpiLast.innerHTML = opts.lastFrameHtml;
    const kpiSeq = host.querySelector<HTMLElement>('[data-net-kpi="seq"]');
    if (kpiSeq && kpiSeq.textContent !== opts.seqText) kpiSeq.textContent = opts.seqText;
    const kpiPos = host.querySelector<HTMLElement>('[data-net-kpi="track-pos"]');
    if (kpiPos && kpiPos.innerHTML !== opts.trackPosHtml) kpiPos.innerHTML = opts.trackPosHtml;

    if (opts.kvTrackPosHtml !== undefined) {
      const kvPos = host.querySelector<HTMLElement>('[data-net-kv="track-pos"]');
      if (kvPos && kvPos.innerHTML !== opts.kvTrackPosHtml) kvPos.innerHTML = opts.kvTrackPosHtml;
    }

    const barSource = host.querySelector<HTMLElement>("[data-net-bar-source]");
    if (barSource && barSource.textContent !== opts.sourceLabel) barSource.textContent = opts.sourceLabel;

    for (let idx = 0; idx < 8; idx++) {
      const fillEl = host.querySelector<HTMLElement>(`[data-bar-fill="${idx}"]`);
      const valEl = host.querySelector<HTMLElement>(`[data-bar-val="${idx}"]`);
      if (!fillEl && !valEl) continue;
      const onCh = Boolean(this.signalEnabledCh[idx]);
      const val = opts.dbmSource ? opts.dbmSource[idx] : undefined;
      const valid = onCh && val !== undefined && val > -127 && val < 0;
      const widthStr = `${(valid ? pct(val!) : 0).toFixed(1)}%`;
      const valStr = !onCh ? "Off" : valid ? `${val!.toFixed(1)} dBm` : "—";

      if (fillEl && fillEl.style.width !== widthStr) fillEl.style.width = widthStr;
      if (valEl && valEl.textContent !== valStr) valEl.textContent = valStr;
    }
    return true;
  }

  private renderTimerSection(hub: TopologyHubInfo, spokes: Map<number, TopologySpokeInfo>, selectedSlot: number): void {
    const s = this.activeStatus();
    const barSpecKey = [
      this.surveyAllRaceband ? "rb" : "pilots",
      this.isLiveRaceHeatActive() ? "race1" : "race0",
      this.surveyError ?? "",
      ...this.visibleBarSpecs().map((b) => `${b.idx}:${b.mhz}:${b.pilot}`),
    ].join(";");
    const detailHost = this.slot("timer-detail");

    if (selectedSlot === 1) {
      if (!hub.populated) {
        const isBleEmpty = this.store.timingHardwareMode === "slaprf_ble";
        const emptyHubHtml = `
          <div class="debug-status-topbar">
            <span class="debug-led-status">
              <span class="status-dot"></span>
              <span class="debug-head-note"><strong>${isBleEmpty ? "Bluetooth Hub" : "TDMA Slot 1"}</strong> · ${isBleEmpty ? "No Bluetooth Hub connected" : "Empty parent Hub slot"}</span>
            </span>
            <div class="debug-connect-actions">
              <span class="badge">${isBleEmpty ? "Bluetooth · Idle" : "Slot 1 · Empty"}</span>
            </div>
          </div>
          <div class="debug-subbox">
            <p class="note">${
              isBleEmpty
                ? "No SlapRF Bluetooth Hub is currently connected. Click Connect Bluetooth above to connect wirelessly (hold BOOT on the Hub for 3 s to pair with a new device)."
                : "No Hub timer is currently connected on TDMA Slot 1. Connect your Hub over USB-C to coordinate the 2.4 GHz network."
            }</p>
          </div>`;
        this.lastTimerStructKey = isBleEmpty ? "empty-1-ble" : "empty-1";
        if (emptyHubHtml !== this.lastTimerHtml) {
          this.lastTimerHtml = emptyHubHtml;
          detailHost.innerHTML = emptyHubHtml;
        }
        return;
      }

      const hubConsole = usbPool.hubConsole() ?? sharedTimerConsole;
      const isBleHub = this.store.timingHardwareMode === "slaprf_ble" || hubConsole.transportLabel === "Bluetooth";
      const populatedSpokes = [...spokes.values()].filter((sp) => sp.populated);
      const activeSpokes = populatedSpokes.filter((sp) => sp.espNowActive);
      const totalSpokeFrames = populatedSpokes.reduce((acc, sp) => acc + (sp.frames ?? 0), 0);
      const totalSpokeRate = populatedSpokes.reduce((acc, sp) => acc + (sp.ratePktPerSec ?? 0), 0);
      const hubOwnFrames = hub.serverFrames ?? 0;
      const totalFrames = totalSpokeFrames + hubOwnFrames;
      const hubOwnRate = hub.online
        ? s && s.role === 1 && s.sweepHz
          ? isBleHub
            ? s.sweepHz
            : s.sweepHz / 2
          : 50
        : 0;
      const totalRate = totalSpokeRate + hubOwnRate;
      let minMsAgo: number | null =
        hubConsole.hubLastFrameAtMs > 0
          ? Math.max(0, Date.now() - hubConsole.hubLastFrameAtMs)
          : null;
      let latestSpokeSeq: number | null = null;
      for (const sp of populatedSpokes) {
        if ((sp.frames ?? 0) > 0 && sp.msAgo !== undefined) {
          if (minMsAgo === null || sp.msAgo < minMsAgo) minMsAgo = sp.msAgo;
        }
        if ((sp.frames ?? 0) > 0 && sp.seq !== undefined) {
          if (latestSpokeSeq === null || sp.seq > latestSpokeSeq) latestSpokeSeq = sp.seq;
        }
      }
      const lastFrameHtml =
        minMsAgo !== null
          ? fmtMsAgoHtml(minMsAgo)
          : hub.online && (hubOwnFrames > 0 || (s && s.role === 1 && s.sweeps > 0))
            ? `<span class="net-metric-pair"><span class="net-num-slot is-ms">&lt;20</span> <span>ms ago</span></span>`
            : "No frames yet";
      const hubSweepSeq =
        hubConsole.hubLastSeq !== undefined
          ? `#${hubConsole.hubLastSeq}`
          : s && s.role === 1 && s.sweeps > 0
            ? `#${s.sweeps}`
            : this.freshLive()?.n !== undefined
              ? `#${this.freshLive()!.n}`
              : hubOwnFrames > 0
                ? `#${hubOwnFrames}`
                : latestSpokeSeq !== null
                  ? `#${latestSpokeSeq}`
                  : "—";

      const ledClass = hub.emergencyMode ? "is-emergency" : hub.online ? "is-up" : hub.populated ? "is-warn" : "";
      const sourceLabel = hub.dbm
        ? hub.viaUsb
          ? isBleHub
            ? "Direct via Bluetooth"
            : "Direct via USB-C"
          : "Engine telemetry"
        : "Waiting for 5.8 GHz sweep data";
      const idBtnHtml = this.renderIdentifyButton(hub.fp, hub.online, hub.label);
      const childSummaryHtml =
        populatedSpokes.length > 0
          ? `${activeSpokes.length}/${populatedSpokes.length} active (${populatedSpokes.map((c) => esc(c.label)).join(", ")})`
          : "None tied yet";
      const trackPosHtml = hub.gateLabel
        ? `${esc(hub.gateLabel)} <span class="note mono">· ${hub.serverFrames ?? 0} samples</span>`
        : `<span class="note">Off track</span>`;
      const kvTrackPosHtml = hub.gateLabel
        ? `${esc(hub.gateLabel)} <span class="note mono">· ${hub.serverFrames ?? 0} samples</span>`
        : `<span class="note">Off track (collector-only mode)</span>`;
      const structKey = [
        "slot1",
        getAppTheme(),
        isBleHub ? "ble" : "usb",
        ledClass,
        hub.label,
        hub.statusNote,
        hub.online ? "1" : "0",
        hub.viaUsb ? "1" : "0",
        hub.fp,
        hub.fw,
        hub.mac,
        hub.ch,
        childSummaryHtml,
        idBtnHtml,
        barSpecKey,
        this.signalEnabledCh.join(","),
      ].join("|");

      const hubRateHtml = fmtRateBadgeHtml(totalRate);
      const hubFramesHtml = fmtFramesBadgeHtml(totalFrames);
      const hubKpiFramesHtml = fmtKpiFramesHtml(totalFrames, totalRate);

      if (
        structKey === this.lastTimerStructKey &&
        this.patchTimerLiveValues(detailHost, {
          rateHtml: hubRateHtml,
          framesHtml: hubFramesHtml,
          kpiFramesHtml: hubKpiFramesHtml,
          lastFrameHtml,
          seqText: hubSweepSeq,
          trackPosHtml,
          kvTrackPosHtml,
          sourceLabel,
          dbmSource: hub.dbm,
        })
      ) {
        return;
      }

      const barsHtml = this.renderRssiBars(
        hub.dbm,
        sourceLabel,
        isBleHub
          ? `5.8 GHz channels at ${esc(hub.label)} (Bluetooth Hub)`
          : `5.8 GHz channels at ${esc(hub.label)} (Hub · Slot 1)`
      );

      const timerHtml = `
        <div class="debug-status-topbar is-net-timer-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}"></span>
            <span class="debug-head-note"><strong>${esc(hub.label)}</strong> · ${isBleHub ? "Bluetooth Hub" : "Parent Hub (TDMA Slot 1)"} · ${esc(hub.statusNote)}</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge ${hub.online ? "badge-good" : "badge-warn"} mono" data-net-top-rate>${hubRateHtml}</span>
            <span class="badge mono" data-net-top-frames>${hubFramesHtml}</span>
            ${hub.fp && hub.fp !== "—" ? `<span class="badge mono net-top-fp-badge">${esc(hub.fp)}</span>` : ""}
            ${idBtnHtml}
          </div>
        </div>

        <div class="debug-net-inspector-kpis">
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Frames received by Hub</span>
            <strong class="debug-net-inspector-kpi-val mono" data-net-kpi="frames">${hubKpiFramesHtml}</strong>
          </div>
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Last frame at Hub</span>
            <strong class="debug-net-inspector-kpi-val mono" data-net-kpi="last-frame">${lastFrameHtml}</strong>
          </div>
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Latest sweep seq #</span>
            <strong class="debug-net-inspector-kpi-val mono" data-net-kpi="seq">${hubSweepSeq}</strong>
          </div>
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Track position &amp; engine rx</span>
            <strong class="debug-net-inspector-kpi-val" data-net-kpi="track-pos">${trackPosHtml}</strong>
          </div>
        </div>

        <div class="debug-timer-detail-grid">
          <div class="debug-subbox">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title is-active">${icons.wifi(14)}<span>${isBleHub ? "Identity &amp; Bluetooth link" : "Identity &amp; 2.4 GHz coordination"}</span></span>
              <span class="badge ${hub.online ? "badge-good" : ""}">${hub.viaUsb ? (isBleHub ? "Bluetooth Connected" : "USB-C Connected") : hub.online ? "Online" : "Offline"}</span>
            </div>
            <div class="debug-net-node-banner is-hub">
              <div class="debug-net-node-main">
                <span class="debug-net-role-tag is-hub">${isBleHub ? "HUB · BLUETOOTH" : "HUB · PARENT"}</span>
                <strong class="debug-net-node-name">${esc(hub.label)}</strong>
              </div>
              <span class="badge mono">${esc(hub.fp)}</span>
            </div>
            <dl class="debug-kv-list">
              ${
                isBleHub
                  ? `<div class="debug-kv-row">
                       <dt>Transport</dt>
                       <dd>Bluetooth LE <span class="note">· ${s?.ble ? `${(s.ble.intervalUs / 1000).toFixed(2).replace(/\.00$/, "")} ms · ${s.ble.rssi} dBm` : "Slot 1 Hub"}</span></dd>
                     </div>
                     <div class="debug-kv-row">
                       <dt>BLE pairing</dt>
                       <dd>${s?.ble ? (s.ble.pairingMode ? "Open pairing mode" : s.ble.paired === false ? "Unpaired" : "Paired to this device") : "Paired"}</dd>
                     </div>
                     <div class="debug-kv-row">
                       <dt>2.4 GHz link</dt>
                       <dd>ESP-NOW (6 Mbps OFDM) <span class="note">· Ch ${hub.ch}</span></dd>
                     </div>
                     <div class="debug-kv-row">
                       <dt>Child Spokes</dt>
                       <dd>${childSummaryHtml}</dd>
                     </div>`
                  : `<div class="debug-kv-row">
                       <dt>TDMA slot</dt>
                       <dd>Slot 1 <span class="note">· Beacon master &amp; USB collector</span></dd>
                     </div>
                     <div class="debug-kv-row">
                       <dt>2.4 GHz link</dt>
                       <dd>ESP-NOW (6 Mbps OFDM) <span class="note">· Ch ${hub.ch}</span></dd>
                     </div>
                     <div class="debug-kv-row">
                       <dt>Child Spokes</dt>
                       <dd>${childSummaryHtml}</dd>
                     </div>`
              }
              <div class="debug-kv-row">
                <dt>Track position</dt>
                <dd data-net-kv="track-pos">${kvTrackPosHtml}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Firmware &amp; MAC</dt>
                <dd><span class="mono">${esc(hub.fw)}</span> <span class="note mono">· ${esc(hub.mac)}</span></dd>
              </div>
            </dl>
          </div>

          <div class="debug-subbox">
            ${barsHtml}
          </div>
        </div>`;

      this.lastTimerStructKey = structKey;
      if (timerHtml !== this.lastTimerHtml) {
        this.lastTimerHtml = timerHtml;
        detailHost.innerHTML = timerHtml;
      }
      return;
    }

    const sp = spokes.get(selectedSlot);
    if (!sp || !sp.populated) {
      const emptyTimerHtml = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot"></span>
            <span class="debug-head-note"><strong>TDMA Slot ${selectedSlot}</strong> · Empty child Spoke slot</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge">Slot ${selectedSlot} · Empty</span>
          </div>
        </div>
        <div class="debug-subbox">
          <p class="note">No child Spoke timer is currently occupying TDMA Slot ${selectedSlot}. Power on a Spoke configured for this Hub or flash a timer in the Flasher tab to join the 2.4 GHz network.</p>
        </div>`;
      this.lastTimerStructKey = `empty-${selectedSlot}`;
      if (emptyTimerHtml !== this.lastTimerHtml) {
        this.lastTimerHtml = emptyTimerHtml;
        detailHost.innerHTML = emptyTimerHtml;
      }
      return;
    }

    const rate = sp.ratePktPerSec ?? 0;
    const frames = sp.frames ?? 0;
    const spokeIdx = sp.slot >= 2 ? sp.slot - 2 : 0;
    const tdmaGap = Math.floor(spokeIdx / 3);
    const tdmaOffsetUs = 300 + (spokeIdx % 3) * 3500;
    const dbmSource =
      sp.dbm && sp.dbm.length === 8
        ? sp.dbm
        : sp.espNowActive && sp.serverRssi && sp.serverRssi.some((v) => v < 0)
          ? sp.serverRssi.map((v) => Math.round(v))
          : null;
    const sourceLabel = dbmSource
      ? sp.viaUsb
        ? "Direct via USB-C"
        : `Via Hub ${esc(hub.label)}`
      : "Waiting for Spoke window frames…";
    const lastFrameHtml = sp.viaUsb
      ? sp.beaconMsAgo !== undefined
        ? fmtMsAgoHtml(sp.beaconMsAgo)
        : "Waiting…"
      : sp.msAgo !== undefined && frames > 0
        ? fmtMsAgoHtml(sp.msAgo)
        : "No frames yet";
    const seqText = sp.seq !== undefined && frames > 0 ? `#${sp.seq}` : "—";
    const trackPosHtml = sp.serverGateLabel
      ? `${esc(sp.serverGateLabel)} <span class="note mono">· ${sp.serverFrames ?? 0} samples</span>`
      : `<span class="note">Off track</span>`;
    const idBtnHtml = this.renderIdentifyButton(sp.fp, sp.espNowActive, sp.label);
    const structKey = [
      `slot${sp.slot}`,
      getAppTheme(),
      sp.espNowActive ? "1" : "0",
      sp.viaUsb ? "1" : "0",
      sp.label,
      sp.fp,
      sp.fw,
      sp.mac ?? "",
      hub.label,
      hub.fp,
      hub.ch,
      idBtnHtml,
      barSpecKey,
      this.signalEnabledCh.join(","),
    ].join("|");

    const spRateHtml = fmtRateBadgeHtml(rate);
    const spFramesHtml = fmtFramesBadgeHtml(frames);
    const spKpiFramesHtml = fmtKpiFramesHtml(frames, rate);

    if (
      structKey === this.lastTimerStructKey &&
      this.patchTimerLiveValues(detailHost, {
        rateHtml: spRateHtml,
        framesHtml: spFramesHtml,
        kpiFramesHtml: spKpiFramesHtml,
        lastFrameHtml,
        seqText,
        trackPosHtml,
        sourceLabel,
        dbmSource,
      })
    ) {
      return;
    }

    const barsHtml = this.renderRssiBars(
      dbmSource,
      sourceLabel,
      `5.8 GHz channels received from ${esc(sp.label)} (Slot ${sp.slot})`
    );

    const timerHtml = `
      <div class="debug-status-topbar is-net-timer-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${sp.espNowActive ? "is-spoke" : "is-warn"}"></span>
          <span class="debug-head-note"><strong>${esc(sp.label)}</strong> · Child Spoke (TDMA Slot ${sp.slot}) · ${sp.espNowActive ? `ESP-NOW active with ${esc(hub.label)}` : "ESP-NOW inactive"}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge ${sp.espNowActive ? "badge-good" : "badge-warn"} mono" data-net-top-rate>${spRateHtml}</span>
          <span class="badge mono" data-net-top-frames>${spFramesHtml}</span>
          <span class="badge mono net-top-fp-badge">${esc(sp.fp)}</span>
          ${idBtnHtml}
        </div>
      </div>

      <div class="debug-net-inspector-kpis">
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">Frames received by Hub</span>
          <strong class="debug-net-inspector-kpi-val mono" data-net-kpi="frames">${spKpiFramesHtml}</strong>
        </div>
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">${sp.viaUsb ? "Last Hub beacon" : "Last frame at Hub"}</span>
          <strong class="debug-net-inspector-kpi-val mono" data-net-kpi="last-frame">${lastFrameHtml}</strong>
        </div>
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">Latest sweep seq #</span>
          <strong class="debug-net-inspector-kpi-val mono" data-net-kpi="seq">${seqText}</strong>
        </div>
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">Track position &amp; engine rx</span>
          <strong class="debug-net-inspector-kpi-val" data-net-kpi="track-pos">${trackPosHtml}</strong>
        </div>
      </div>

      <div class="debug-timer-detail-grid">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title is-active">${icons.cpu(14)}<span>Spoke identity &amp; TDMA schedule</span></span>
            <span class="badge ${sp.espNowActive ? "badge-good" : "badge-warn"}">${sp.espNowActive ? `Slot ${sp.slot} · Active` : `Slot ${sp.slot} · Inactive`}</span>
          </div>
          <div class="debug-net-node-banner is-spoke">
            <div class="debug-net-node-main">
              <span class="debug-net-role-tag is-spoke">SPOKE · CHILD</span>
              <strong class="debug-net-node-name">${esc(sp.label)}</strong>
            </div>
            <span class="badge mono">${esc(sp.fp)}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Assigned TDMA slot</dt>
              <dd>Slot ${sp.slot} of 7 <span class="note">· gap ${tdmaGap}, +${(tdmaOffsetUs / 1000).toFixed(1)} ms</span></dd>
            </div>
            <div class="debug-kv-row">
              <dt>Parent Hub</dt>
              <dd><strong>${esc(hub.label)}</strong> <span class="note">· TDMA Slot 1 (${esc(hub.fp)})</span></dd>
            </div>
            <div class="debug-kv-row">
              <dt>2.4 GHz ESP-NOW link</dt>
              <dd>${sp.espNowActive ? `Active · Ch ${hub.ch}` : `Inactive · Ch ${hub.ch}`}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware &amp; MAC</dt>
              <dd><span class="mono">${esc(sp.fw)}</span>${sp.mac ? ` <span class="note mono">· ${esc(sp.mac)}</span>` : ""}</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          ${barsHtml}
        </div>
      </div>`;

    this.lastTimerStructKey = structKey;
    if (timerHtml !== this.lastTimerHtml) {
      this.lastTimerHtml = timerHtml;
      detailHost.innerHTML = timerHtml;
    }
  }
}
