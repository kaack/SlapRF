import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  LiveSample,
  sharedTimerConsole,
  TimerConsole,
  TimerStatus,
  usbPool,
} from "../services/timer_console";
import { AppStore } from "../state/store";
import { DetectedTimer } from "../types/models";
import { patchUsbConnectionBar } from "../widgets/UsbConnectionBar";
import { CHANNEL_COLORS, DBM_MAX, DBM_MIN, RACEBAND, racebandName } from "./debug/charts";

const NETWORK_PREFS_KEY = "slaprf.ui.network_prefs.v1";

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
  /** Selected TDMA slot in the topology (1 = Center Hub, 2..7 = Child Spokes). */
  private selectedSlot: number | null = null;
  private userPickedSlot = false;
  private spokeRateTracker = new Map<number, { frames: number; atMs: number; ratePktPerSec: number }>();
  private signalEnabledCh: boolean[] = [true, true, true, true, true, true, true, true];
  private lastTopologyHtml = "";
  private lastTimerHtml = "";
  private showAllPorts = false;
  private connError: string | null = null;
  /** Identify toggles sent but not yet confirmed by a status line (fingerprint -> wanted state). */
  private identifyPending = new Map<string, { on: boolean; atMs: number }>();

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
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Connection</h2>
            <p>Connect the Hub (or a Spoke) over USB-C to inspect the 2.4 GHz network and 5.8 GHz channel readings.</p>
          </div>
          <div class="debug-status-layout" data-slot="connection"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Topology</h2>
            <p>Parent Hub (Slot 1) in the center with 6 Spoke slots (Slots 2–7) around it. Active ESP-NOW links are solid; open or inactive slots are dashed. Click any slot to inspect it below.</p>
          </div>
          <div class="debug-status-layout" data-slot="topology"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timer</h2>
            <p>Identity, 2.4 GHz TDMA link stats, and live 5.8 GHz channel readings for the selected slot.</p>
          </div>
          <div class="debug-status-layout" data-slot="timer-detail"></div>
        </section>
      </div>`;

    const unsubMain = this.console.subscribe({
      onConnect: () => {
        this.status = this.activeStatus();
        this.renderAll();
      },
      onStatus: (s) => {
        this.status = this.activeStatus();
        if (s.chanMask !== undefined) {
          const nextEnabled = Array.from({ length: 8 }, (_, i) => ((s.chanMask! >> i) & 1) !== 0);
          if (nextEnabled.join() !== this.signalEnabledCh.join()) {
            this.signalEnabledCh = nextEnabled;
          }
        }
        this.renderAll();
      },
      onLive: (l) => {
        this.live = l;
        if (this.selectedSlot === 1 || (this.status?.role === 2 && this.selectedSlot === this.status.slot)) {
          this.renderAll();
        }
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
        }
        this.renderAll();
      },
    });

    const unsubState = usbPool.onChange(() => {
      this.status = this.activeStatus();
      this.renderAll();
    });

    const unsubBridge = this.api.hubBridge.subscribe(() => {
      this.renderAll();
    });

    const unsubStore = this.store.subscribe(["status", "config"], () => {
      this.renderAll();
    });

    this.listen(el, "pointerdown", (e) => {
      if ((e as PointerEvent).button !== 0) return;
      const idBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="toggle-identify"]');
      if (idBtn) {
        if (!idBtn.disabled) void this.toggleIdentify(idBtn.dataset.fp || "", idBtn.dataset.on !== "1");
        return;
      }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-action="select-topology-slot"]');
      if (!t) return;
      this.selectTopologySlot(Number(t.dataset.slotNum));
    });
    this.listen(el, "click", (e) => void this.onClick(e));
    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-all-ports]")) {
        this.showAllPorts = t.checked;
        this.savePrefs();
      }
    });

    this.onDispose(() => {
      unsubMain();
      unsubState();
      unsubBridge();
      unsubStore();
    });

    this.renderAll();
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

  private activeStatus(): TimerStatus | null {
    const primary = usbPool.mainConsole;
    if (primary.connected && primary.lastStatus) {
      return primary.lastStatus;
    }
    return null;
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
          const c = await usbPool.connectMain(this.showAllPorts);
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
    }
  }

  private buildTopologyState(): {
    hub: TopologyHubInfo;
    spokes: Map<number, TopologySpokeInfo>;
  } {
    const s = this.activeStatus();
    const hubConsole = usbPool.hubConsole();
    const hubUsbStatus = s && s.role === 1 ? s : hubConsole?.connected ? hubConsole.lastStatus : null;
    const detectedTimers: DetectedTimer[] = this.store.detectedTimers;
    const ch = hubUsbStatus?.channel || s?.channel || 1;
    const nowMs = performance.now();

    const formatTrackPos = (g: { trackOrder: number; role: string }) =>
      `Track #${g.trackOrder + 1}${g.role === "START_FINISH" ? " (Start)" : ""}`;

    const hubGate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === 1);
    const hubGateName = hubGate ? formatTrackPos(hubGate) : undefined;
    const hubServerTimer = detectedTimers.find((t) => t.isHub || t.timerId === 1);

    let hub: TopologyHubInfo;
    if (!this.store.simulatorRunning && hubUsbStatus && hubUsbStatus.role === 1) {
      const liveDbm =
        s && s.role === 1 && this.live?.dbm?.length === 8
          ? this.live.dbm
          : hubUsbStatus.dbm?.length === 8
            ? hubUsbStatus.dbm
            : sharedTimerConsole.hubLastDbm?.length === 8
              ? sharedTimerConsole.hubLastDbm
              : Array.isArray(hubGate?.lastRssi)
                ? hubGate!.lastRssi!.slice(0, 8).map((v) => Math.round(v))
                : Array.isArray(hubServerTimer?.lastRssi)
                  ? hubServerTimer!.lastRssi!.slice(0, 8).map((v) => Math.round(v))
                  : undefined;
      const hubFrames = Math.max(
        sharedTimerConsole.hubOwnFrames,
        hubGate?.framesRxCount ?? 0,
        hubServerTimer?.framesRxCount ?? 0
      );
      hub = {
        populated: true,
        online: !hubUsbStatus.emergencyMode,
        label: hubUsbStatus.label || hubServerTimer?.timerLabel || "",
        fp: hubUsbStatus.fp || "—",
        fw: hubUsbStatus.fw || "—",
        mac: hubUsbStatus.chip?.mac || "—",
        ch,
        viaUsb: true,
        emergencyMode: Boolean(hubUsbStatus.emergencyMode),
        gateLabel: hubGateName,
        serverFrames: hubFrames,
        dbm: liveDbm,
        statusNote: hubUsbStatus.emergencyMode ? "Emergency mode" : "USB-C · Beacon master",
      };
    } else if (!this.store.simulatorRunning && s && s.role === 2) {
      const rawBeaconMsAgo = s.beaconMsAgo ?? s.hub?.beaconMsAgo;
      const beaconMsAgo = rawBeaconMsAgo !== undefined && rawBeaconMsAgo >= 0x80000000 ? 0 : rawBeaconMsAgo;
      const hasSlot = !s.emergencyMode && s.slot >= 2;
      const beaconFresh = beaconMsAgo !== undefined && beaconMsAgo < 2500;
      const linked = hasSlot && beaconFresh;
      const parentLabel = s.hub?.label || "";
      const parentFp = s.hub?.fp || "";
      const parentFw = s.hub?.fw || s.fw;
      const parentMac = s.hub?.mac || "—";
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
        statusNote: linked ? `Sync beacon locked` : hasSlot ? "Beacon lost" : "Not connected",
      };
    } else if (this.store.simulatorRunning && hubServerTimer) {
      const liveDbm = Array.isArray(hubGate?.lastRssi)
        ? hubGate!.lastRssi!.slice(0, 8).map((v) => Math.round(v))
        : Array.isArray(hubServerTimer.lastRssi)
          ? hubServerTimer.lastRssi.slice(0, 8).map((v) => Math.round(v))
          : undefined;
      hub = {
        populated: true,
        online: Boolean(hubServerTimer.online),
        label: hubServerTimer.timerLabel || "",
        fp: hubServerTimer.fingerprint || "—",
        fw: hubServerTimer.firmwareVersion || "—",
        mac: "—",
        ch: 1,
        viaUsb: false,
        emergencyMode: false,
        gateLabel: hubGateName,
        serverFrames: Math.max(hubGate?.framesRxCount ?? 0, hubServerTimer.framesRxCount ?? 0),
        dbm: liveDbm,
        statusNote: "Simulated Hub",
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

    // 1. Live Hardware: If connected to a Hub over USB, populate only active Spokes detected by the Hub
    if (!this.store.simulatorRunning && hubUsbStatus && hubUsbStatus.role === 1 && Array.isArray(hubUsbStatus.spokes)) {
      for (const sp of hubUsbStatus.spokes) {
        if (sp.slot >= 2 && sp.slot <= 7) {
          const rawFp = (sp.fp || "").toUpperCase();
          const isFallbackFp = !rawFp || rawFp.startsWith("53504B");
          const frames = sp.frames ?? 0;
          const msAgo = sp.msAgo !== undefined && sp.msAgo >= 0x80000000 ? 0 : sp.msAgo;
          // Ignore synthetic slot placeholders that have never transmitted and Spokes that are no longer active
          if (isFallbackFp && frames === 0) continue;
          if (msAgo !== undefined && msAgo >= 5000) continue;

          const fp = !isFallbackFp && rawFp ? rawFp : `SLOT${sp.slot}`;
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
          const activelyReceiving = frames > 0 && (msAgo === undefined || msAgo < 2500);
          const matchedDt = !isFallbackFp
            ? detectedTimers.find((t) => (t.fingerprint || "").toUpperCase() === rawFp)
            : undefined;
          const gate = matchedDt ? this.store.nodes.find((g) => g.assignedTimerId === matchedDt.timerId) : undefined;
          const gateName = gate ? formatTrackPos(gate) : undefined;
          const cleanSpLabel = isFallbackFp ? "" : sp.label;
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
            seq: sp.seq,
            dbm: sp.dbm,
            ratePktPerSec,
            serverFrames: gate?.framesRxCount ?? matchedDt?.framesRxCount ?? 0,
            serverGateLabel: gateName,
            serverRssi: Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined,
            sourceNote,
          });
        }
      }
    }

    // 2. Live Hardware: Populate Spoke if the main USB connection is a Spoke
    if (!this.store.simulatorRunning) {
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
          seq: existingFromHub?.seq,
          dbm:
            isCurrentConsole && this.live?.dbm?.length === 8
              ? this.live.dbm
              : spStatus.dbm?.length === 8
                ? spStatus.dbm
                : existingFromHub?.dbm,
          ratePktPerSec: existingFromHub?.ratePktPerSec ?? (linked ? 25 : 0),
          serverFrames: gate?.framesRxCount ?? matchedDt?.framesRxCount ?? 0,
          serverGateLabel: gateName,
          serverRssi: Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined,
          sourceNote: spStatus.emergencyMode
            ? "Emergency mode · USB-C"
            : linked
              ? `USB-C · Synced (${beaconMsAgo ?? 0} ms)`
              : hasSlot
                ? "USB-C · Beacon lost"
                : "USB-C · Searching for Hub",
        });
      }
    }

    // 3. Simulator: Populate simulated Spokes when the simulator is running
    if (this.store.simulatorRunning) {
      for (const dt of detectedTimers) {
        if (!dt.isHub && dt.timerId >= 2 && dt.timerId <= 7) {
          const fp = (dt.fingerprint || "").toUpperCase();
          const gate = this.store.nodes.find((g) => g.assignedTimerId === dt.timerId);
          const gateName = gate ? formatTrackPos(gate) : undefined;
          const serverFrames = gate?.framesRxCount ?? dt.framesRxCount ?? 0;
          const serverRssi = Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined;
          const serverOnline = Boolean(dt.online);
          spokes.set(dt.timerId, {
            slot: dt.timerId,
            populated: true,
            espNowActive: serverOnline,
            inHubStatus: serverOnline,
            viaUsb: false,
            label: dt.timerLabel || "",
            fp: fp || "—",
            fw: dt.firmwareVersion || hub.fw,
            frames: serverFrames,
            ratePktPerSec: dt.online ? 25 : 0,
            serverFrames,
            serverGateLabel: gateName,
            serverRssi,
            sourceNote: serverOnline ? `Simulating · ${serverFrames} frames` : `Offline · 0 frames rx`,
          });
        }
      }
    }

    // 4. Fill any remaining slots (2..7) with empty placeholders (no pre-assigned timer name)
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

  private ensureSelectedSlot(hub: TopologyHubInfo, spokes: Map<number, TopologySpokeInfo>): number {
    const s = this.activeStatus();
    if (this.userPickedSlot && this.selectedSlot !== null && this.selectedSlot >= 1 && this.selectedSlot <= 7) {
      return this.selectedSlot;
    }
    if (this.selectedSlot !== null && this.selectedSlot >= 2 && this.selectedSlot <= 7) {
      const sp = spokes.get(this.selectedSlot);
      if (sp?.populated) return this.selectedSlot;
    }
    if (s && s.role === 2 && s.slot >= 2 && s.slot <= 7) {
      this.selectedSlot = s.slot;
      return this.selectedSlot;
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
    const connHost = this.el.querySelector<HTMLElement>('[data-slot="connection"]');
    patchUsbConnectionBar(connHost, {
      activeConsole: usbPool.mainConsole,
      showAllPorts: this.showAllPorts,
      error: this.connError,
    });
    const { hub, spokes } = this.buildTopologyState();
    const sel = this.ensureSelectedSlot(hub, spokes);
    this.renderTopologySection(hub, spokes, sel);
    this.renderTimerSection(hub, spokes, sel);
  }

  private renderSpokeNodeCard(sp: TopologySpokeInfo, isSelected: boolean): string {
    const slotNum = sp.slot;
    if (!sp.populated) {
      return `
        <button type="button" class="debug-topo-node is-spoke is-empty is-inactive-link ${isSelected ? "is-selected" : ""}" data-action="select-topology-slot" data-slot-num="${slotNum}" aria-pressed="${isSelected}" title="TDMA Slot ${slotNum} (Open) · click to view slot details">
          <div class="debug-topo-node-head">
            <span class="debug-topo-slot-tag mono">Slot ${slotNum}</span>
            <span class="note">Open</span>
          </div>
          <div class="debug-topo-node-main">
            <span class="status-dot"></span>
            <span class="note">Unassigned</span>
          </div>
          <div class="debug-topo-node-foot">
            <span class="note">Available Spoke slot</span>
          </div>
        </button>`;
    }

    const active = sp.espNowActive;
    const dotClass = active ? "is-spoke" : sp.inHubStatus ? "is-warn" : "";
    const stateBadgeClass = active ? "badge-good" : sp.inHubStatus ? "badge-warn" : "";
    const stateBadgeText = active ? "ESP-NOW Active" : sp.viaUsb ? "USB-C" : sp.inHubStatus ? "Stale" : "Inactive";
    const cardStatusText = active
      ? this.store.simulatorRunning
        ? "Simulated link"
        : sp.viaUsb
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
          <span class="debug-topo-slot-tag mono">Slot ${slotNum}${sp.viaUsb ? " · USB" : ""}</span>
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
    } else if (this.store.simulatorRunning) {
      topLed = "is-up";
      topText = `Simulator active · Hub ${esc(hub.label)} + ${activeCount} simulated Spoke${activeCount === 1 ? "" : "s"}`;
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

    const hubSelected = selectedSlot === 1;
    const hubDotClass = hub.emergencyMode ? "is-emergency" : hub.online ? "is-up" : hub.populated ? "is-warn" : "";
    const hubBadgeClass = hub.online ? "badge-good" : hub.populated ? "badge-warn" : "";
    const hubBadgeText = hub.viaUsb ? "USB-C · Active" : hub.online ? "Online" : hub.populated ? "Idle" : "Empty";

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
              <span class="debug-net-role-tag is-hub">HUB · SLOT 1</span>
              <span class="badge ${hubBadgeClass}">${hubBadgeText}</span>
            </div>
            <div class="debug-topo-node-main is-hub-main">
              <span class="status-dot ${hubDotClass}"></span>
              ${hub.populated && hub.label ? `<strong class="debug-topo-hub-name">${esc(hub.label)}</strong>` : `<span class="note">Unassigned</span>`}
              ${hub.populated && hub.fp && hub.fp !== "—" ? `<span class="badge mono">${esc(hub.fp)}</span>` : ""}
            </div>
            <div class="debug-topo-hub-meta">
              <span>${esc(hub.statusNote)}</span>
              ${hub.populated ? `<span class="mono">2.4 GHz Ch ${hub.ch} · ${activeCount}/${tiedCount} active</span>` : `<span class="note">Available Hub slot</span>`}
            </div>
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
        <span class="debug-topo-legend-item"><span class="debug-topo-legend-line is-dashed"></span><span>Dashed = Inactive / open slot</span></span>
        <span class="note">Click the center Hub or any Spoke slot to inspect its details below.</span>
      </div>`;

    if (topologyHtml !== this.lastTopologyHtml) {
      this.lastTopologyHtml = topologyHtml;
      this.slot("topology").innerHTML = topologyHtml;
    }
  }

  private renderRssiBars(freqs: number[], dbmSource: number[] | null | undefined, sourceLabel: string, titleText: string): string {
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    const barsHtml = freqs
      .map((f, idx) => {
        const band = racebandName(f) || `Ch${idx + 1}`;
        const col = CHANNEL_COLORS[idx];
        const onCh = Boolean(this.signalEnabledCh[idx]);
        const val = dbmSource ? dbmSource[idx] : undefined;
        const valid = onCh && val !== undefined && val > -127 && val < 0;
        const widthPct = valid ? pct(val!) : 0;
        return `
          <div class="debug-net-inspector-bar-row ${onCh ? "" : "is-muted"}">
            <span class="debug-bar-label mono"><span class="debug-ch-inline" style="${onCh ? `background:${col}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col}`}"></span><strong>${band}</strong> ${f}</span>
            <div class="debug-bar-track">
              <span class="debug-bar-fill" style="width:${widthPct.toFixed(1)}%"></span>
            </div>
            <span class="debug-bar-value mono">${!onCh ? "Off" : valid ? `${val} dBm` : "—"}</span>
          </div>`;
      })
      .join("");

    return `
      <div class="debug-net-inspector-bars-wrap">
        <div class="debug-subbar">
          <span class="debug-chart-title">${titleText}</span>
          <span class="note mono">${sourceLabel}</span>
        </div>
        <div class="debug-net-inspector-bars">${barsHtml}</div>
      </div>`;
  }

  private renderTimerSection(hub: TopologyHubInfo, spokes: Map<number, TopologySpokeInfo>, selectedSlot: number): void {
    const s = this.activeStatus();
    const freqs = s?.freqs?.length === 8 ? s.freqs : RACEBAND;

    if (selectedSlot === 1) {
      if (!hub.populated) {
        const emptyHubHtml = `
          <div class="debug-status-topbar">
            <span class="debug-led-status">
              <span class="status-dot"></span>
              <span class="debug-head-note"><strong>TDMA Slot 1</strong> · Open parent Hub slot</span>
            </span>
            <div class="debug-connect-actions">
              <span class="badge">Slot 1 · Open</span>
            </div>
          </div>
          <div class="debug-subbox">
            <p class="note">No Hub timer is currently connected on TDMA Slot 1. Connect your Hub over USB-C (or enable the simulator) to coordinate the 2.4 GHz network.</p>
          </div>`;
        if (emptyHubHtml !== this.lastTimerHtml) {
          this.lastTimerHtml = emptyHubHtml;
          this.slot("timer-detail").innerHTML = emptyHubHtml;
        }
        return;
      }

      const populatedSpokes = [...spokes.values()].filter((sp) => sp.populated);
      const activeSpokes = populatedSpokes.filter((sp) => sp.espNowActive);
      const totalSpokeFrames = populatedSpokes.reduce((acc, sp) => acc + (sp.frames ?? 0), 0);
      const totalSpokeRate = populatedSpokes.reduce((acc, sp) => acc + (sp.ratePktPerSec ?? 0), 0);
      const hubOwnFrames = hub.serverFrames ?? 0;
      const totalFrames = totalSpokeFrames + hubOwnFrames;
      const hubOwnRate = hub.online ? (s && s.role === 1 && s.sweepHz ? s.sweepHz / 2 : 50) : 0;
      const totalRate = totalSpokeRate + hubOwnRate;

      let minMsAgo: number | null =
        sharedTimerConsole.hubLastFrameAtMs > 0
          ? Math.max(0, Date.now() - sharedTimerConsole.hubLastFrameAtMs)
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
      const lastFrameText =
        minMsAgo !== null
          ? `${minMsAgo} ms ago`
          : hub.online && (hubOwnFrames > 0 || (s && s.role === 1 && s.sweeps > 0))
            ? "< 20 ms ago"
            : "No frames yet";
      const hubSweepSeq =
        sharedTimerConsole.hubLastSeq !== undefined
          ? `#${sharedTimerConsole.hubLastSeq}`
          : s && s.role === 1 && s.sweeps > 0
            ? `#${s.sweeps}`
            : this.live?.n !== undefined
              ? `#${this.live.n}`
              : hubOwnFrames > 0
                ? `#${hubOwnFrames}`
                : latestSpokeSeq !== null
                  ? `#${latestSpokeSeq}`
                  : "—";

      const ledClass = hub.emergencyMode ? "is-emergency" : hub.online ? "is-up" : hub.populated ? "is-warn" : "";
      const barsHtml = this.renderRssiBars(
        freqs,
        hub.dbm,
        hub.dbm ? (hub.viaUsb ? "Direct via USB-C" : "Engine telemetry") : "Waiting for 5.8 GHz sweep data",
        `5.8 GHz channels at ${esc(hub.label)} (Hub · Slot 1)`
      );

      const timerHtml = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}"></span>
            <span class="debug-head-note"><strong>${esc(hub.label)}</strong> · Parent Hub (TDMA Slot 1) · ${esc(hub.statusNote)}</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge ${hub.online ? "badge-good" : "badge-warn"} mono">${totalRate.toFixed(1)} pkt/s</span>
            <span class="badge mono">${totalFrames} frames rx</span>
            ${hub.fp && hub.fp !== "—" ? `<span class="badge mono">${esc(hub.fp)}</span>` : ""}
            ${this.renderIdentifyButton(hub.fp, hub.online, hub.label)}
          </div>
        </div>

        <div class="debug-net-inspector-kpis">
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Frames received by Hub</span>
            <strong class="debug-net-inspector-kpi-val mono">${totalFrames} <span class="note">(${totalRate.toFixed(1)} pkt/s)</span></strong>
          </div>
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Last frame at Hub</span>
            <strong class="debug-net-inspector-kpi-val mono">${lastFrameText}</strong>
          </div>
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Latest sweep seq #</span>
            <strong class="debug-net-inspector-kpi-val mono">${hubSweepSeq}</strong>
          </div>
          <div class="debug-net-inspector-kpi">
            <span class="debug-net-inspector-kpi-label">Track position &amp; engine rx</span>
            <strong class="debug-net-inspector-kpi-val">${hub.gateLabel ? `${esc(hub.gateLabel)} <span class="note mono">· ${hub.serverFrames ?? 0} samples</span>` : `<span class="note">Off track</span>`}</strong>
          </div>
        </div>

        <div class="debug-timer-detail-grid">
          <div class="debug-subbox">
            <div class="debug-subbox-head">
              <span class="debug-subbox-title is-active">${icons.wifi(14)}<span>Identity &amp; 2.4 GHz coordination</span></span>
              <span class="badge ${hub.online ? "badge-good" : ""}">${hub.viaUsb ? "USB-C Connected" : hub.online ? "Online" : "Offline"}</span>
            </div>
            <div class="debug-net-node-banner is-hub">
              <div class="debug-net-node-main">
                <span class="debug-net-role-tag is-hub">HUB · PARENT</span>
                <strong class="debug-net-node-name">${esc(hub.label)}</strong>
              </div>
              <span class="badge mono">${esc(hub.fp)}</span>
            </div>
            <dl class="debug-kv-list">
              <div class="debug-kv-row">
                <dt>TDMA slot</dt>
                <dd>Slot 1 <span class="note">· Beacon master &amp; USB collector</span></dd>
              </div>
              <div class="debug-kv-row">
                <dt>2.4 GHz link</dt>
                <dd>ESP-NOW (6 Mbps OFDM) <span class="note">· Ch ${hub.ch}</span></dd>
              </div>
              <div class="debug-kv-row">
                <dt>Child Spokes</dt>
                <dd>${populatedSpokes.length > 0 ? `${activeSpokes.length}/${populatedSpokes.length} active (${populatedSpokes.map((c) => esc(c.label)).join(", ")})` : "None tied yet"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Track position</dt>
                <dd>${hub.gateLabel ? `${esc(hub.gateLabel)} <span class="note mono">· ${hub.serverFrames ?? 0} samples</span>` : `<span class="note">Off track (collector-only mode)</span>`}</dd>
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

      if (timerHtml !== this.lastTimerHtml) {
        this.lastTimerHtml = timerHtml;
        this.slot("timer-detail").innerHTML = timerHtml;
      }
      return;
    }

    const sp = spokes.get(selectedSlot);
    if (!sp || !sp.populated) {
      const emptyTimerHtml = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot"></span>
            <span class="debug-head-note"><strong>TDMA Slot ${selectedSlot}</strong> · Open child Spoke slot</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge">Slot ${selectedSlot} · Open</span>
          </div>
        </div>
        <div class="debug-subbox">
          <p class="note">No child Spoke timer is currently occupying TDMA Slot ${selectedSlot}. Power on a Spoke configured for this Hub or flash a timer in the Flasher tab to join the 2.4 GHz network.</p>
        </div>`;
      if (emptyTimerHtml !== this.lastTimerHtml) {
        this.lastTimerHtml = emptyTimerHtml;
        this.slot("timer-detail").innerHTML = emptyTimerHtml;
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

    const barsHtml = this.renderRssiBars(
      freqs,
      dbmSource,
      dbmSource ? (sp.viaUsb ? "Direct via USB-C" : `Via Hub ${esc(hub.label)}`) : "Waiting for Spoke window frames…",
      `5.8 GHz channels received from ${esc(sp.label)} (Slot ${sp.slot})`
    );

    const timerHtml = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${sp.espNowActive ? "is-spoke" : "is-warn"}"></span>
          <span class="debug-head-note"><strong>${esc(sp.label)}</strong> · Child Spoke (TDMA Slot ${sp.slot}) · ${sp.espNowActive ? `ESP-NOW active with ${esc(hub.label)}` : "ESP-NOW inactive"}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge ${sp.espNowActive ? "badge-good" : "badge-warn"} mono">${rate.toFixed(1)} pkt/s</span>
          <span class="badge mono">${frames} frames rx</span>
          <span class="badge mono">${esc(sp.fp)}</span>
          ${this.renderIdentifyButton(sp.fp, sp.espNowActive, sp.label)}
        </div>
      </div>

      <div class="debug-net-inspector-kpis">
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">Frames received by Hub</span>
          <strong class="debug-net-inspector-kpi-val mono">${frames} <span class="note">(${rate.toFixed(1)} pkt/s)</span></strong>
        </div>
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">${sp.viaUsb ? "Last Hub beacon" : "Last frame at Hub"}</span>
          <strong class="debug-net-inspector-kpi-val mono">${sp.viaUsb ? (sp.beaconMsAgo !== undefined ? `${sp.beaconMsAgo} ms ago` : "Waiting…") : sp.msAgo !== undefined && frames > 0 ? `${sp.msAgo} ms ago` : "No frames yet"}</strong>
        </div>
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">Latest sweep seq #</span>
          <strong class="debug-net-inspector-kpi-val mono">${sp.seq !== undefined && frames > 0 ? `#${sp.seq}` : "—"}</strong>
        </div>
        <div class="debug-net-inspector-kpi">
          <span class="debug-net-inspector-kpi-label">Track position &amp; engine rx</span>
          <strong class="debug-net-inspector-kpi-val">${sp.serverGateLabel ? `${esc(sp.serverGateLabel)} <span class="note mono">· ${sp.serverFrames ?? 0} samples</span>` : `<span class="note">Off track</span>`}</strong>
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

    if (timerHtml !== this.lastTimerHtml) {
      this.lastTimerHtml = timerHtml;
      this.slot("timer-detail").innerHTML = timerHtml;
    }
  }
}
