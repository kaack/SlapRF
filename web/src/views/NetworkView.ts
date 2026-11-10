import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  getKnownHardwareTimers,
  LiveSample,
  recordKnownHardwareTimer,
  sharedTimerConsole,
  TimerConsole,
  TimerStatus,
} from "../services/timer_console";
import { AppStore } from "../state/store";
import { DetectedTimer } from "../types/models";
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

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    this.console = sharedTimerConsole;
    this.loadPrefs();
    if (this.console.connected && this.console.lastStatus) {
      this.status = this.console.lastStatus;
    }

    el.innerHTML = `
      <div class="settings debug-page network-page">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Topology</h2>
            <p>2.4 GHz ESP-NOW hub-and-spoke network topology with the parent Hub (TDMA Slot 1) in the center and 6 child Spoke slots (TDMA Slots 2–7) around it. Active ESP-NOW links appear solid; inactive or open slots appear dashed. Click any slot to inspect it below.</p>
          </div>
          <div class="debug-status-layout" data-slot="topology"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timer</h2>
            <p>Identity, 2.4 GHz TDMA link telemetry, and live 5.8 GHz channel readings for the timer selected in the topology above.</p>
          </div>
          <div class="debug-status-layout" data-slot="timer-detail"></div>
        </section>
      </div>`;

    const unsubConsole = this.console.subscribe({
      onConnect: () => {
        this.renderAll();
      },
      onStatus: (s) => {
        this.status = s;
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
        this.status = null;
        this.live = null;
        this.renderAll();
      },
    });

    const unsubState = this.console.onStateChange(() => {
      this.renderAll();
    });

    const unsubBridge = this.api.hubBridge.subscribe(() => {
      this.renderAll();
    });

    const unsubStore = this.store.subscribe(["status", "config"], () => {
      this.syncKnownTimersFromStore();
      this.renderAll();
    });

    this.listen(el, "click", (e) => void this.onClick(e));

    this.onDispose(() => {
      unsubConsole();
      unsubState();
      unsubBridge();
      unsubStore();
    });

    this.syncKnownTimersFromStore();
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
      if (Array.isArray(p.signalEnabledCh) && p.signalEnabledCh.length === 8) {
        this.signalEnabledCh = p.signalEnabledCh.map(Boolean);
      }
      if (typeof p.selectedSlot === "number" && p.selectedSlot >= 1 && p.selectedSlot <= 7) {
        this.selectedSlot = p.selectedSlot;
      } else if (typeof p.selectedNetworkSpokeSlot === "number" && p.selectedNetworkSpokeSlot >= 2 && p.selectedNetworkSpokeSlot <= 7) {
        this.selectedSlot = p.selectedNetworkSpokeSlot;
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
          signalEnabledCh: this.signalEnabledCh,
          selectedSlot: this.selectedSlot,
        })
      );
    } catch {
      // ignore
    }
  }

  private syncKnownTimersFromStore(): void {
    if (this.store.simulatorRunning) return;
    for (const dt of this.store.detectedTimers) {
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

  private activeStatus(): TimerStatus | null {
    if (this.console.connected && this.status) {
      return this.status;
    }
    return null;
  }

  private async onClick(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    if (t.dataset.action === "select-topology-slot") {
      const slotNum = Number(t.dataset.slotNum);
      if (slotNum >= 1 && slotNum <= 7) {
        this.selectedSlot = slotNum;
        this.userPickedSlot = true;
        this.renderAll();
        this.savePrefs();
      }
    }
  }

  private buildTopologyState(): {
    hub: TopologyHubInfo;
    spokes: Map<number, TopologySpokeInfo>;
  } {
    const s = this.activeStatus();
    const knownTimers = getKnownHardwareTimers();
    const detectedTimers: DetectedTimer[] = this.store.detectedTimers;
    const ch = s?.channel || 1;
    const nowMs = performance.now();

    const hubGate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === 1);
    const hubGateName = hubGate ? (hubGate.name?.trim() || `Gate ${hubGate.trackOrder + 1}`) : undefined;
    const hubServerTimer = detectedTimers.find((t) => t.isHub || t.timerId === 1);
    const knownHub = knownTimers.find((k) => k.role === "hub");

    let hub: TopologyHubInfo;
    if (s && s.role === 1) {
      const liveDbm = this.live?.dbm?.length === 8 ? this.live.dbm : Array.isArray(hubGate?.lastRssi) ? hubGate!.lastRssi!.slice(0, 8).map((v) => Math.round(v)) : undefined;
      hub = {
        populated: true,
        online: !s.emergencyMode,
        label: s.label || "H1",
        fp: s.fp || "—",
        fw: s.fw || "—",
        mac: s.chip?.mac || knownHub?.mac || "—",
        ch,
        viaUsb: true,
        emergencyMode: Boolean(s.emergencyMode),
        gateLabel: hubGateName,
        serverFrames: hubGate?.framesRxCount ?? 0,
        dbm: liveDbm,
        statusNote: s.emergencyMode ? "Emergency mode" : "USB-C · Beacon master",
      };
    } else if (s && s.role === 2) {
      const selfKnown = knownTimers.find((k) => k.fp.toUpperCase() === s.fp.toUpperCase());
      const matchedHub =
        (s.hub?.fp ? knownTimers.find((k) => k.fp.toUpperCase() === s.hub!.fp!.toUpperCase()) : undefined) ??
        (selfKnown?.parentHubFp ? knownTimers.find((k) => k.fp.toUpperCase() === selfKnown.parentHubFp!.toUpperCase()) : undefined) ??
        knownHub;
      const beaconMsAgo = s.beaconMsAgo ?? s.hub?.beaconMsAgo;
      const hasSlot = !s.emergencyMode && s.slot >= 2;
      const beaconFresh = beaconMsAgo === undefined || beaconMsAgo < 2500;
      const linked = hasSlot && beaconFresh;
      const parentLabel = s.hub?.label || hubServerTimer?.timerLabel || matchedHub?.label || "H1";
      const parentFp = s.hub?.fp || hubServerTimer?.fingerprint || matchedHub?.fp || "";
      const parentFw = s.hub?.fw || hubServerTimer?.firmwareVersion || matchedHub?.fw || s.fw;
      const parentMac = s.hub?.mac || matchedHub?.mac || "—";
      hub = {
        populated: Boolean(linked || parentFp || matchedHub),
        online: linked,
        label: parentLabel,
        fp: parentFp || "Slot 1",
        fw: parentFw || "—",
        mac: parentMac,
        ch,
        viaUsb: false,
        emergencyMode: false,
        gateLabel: hubGateName,
        serverFrames: hubGate?.framesRxCount ?? 0,
        statusNote: linked ? `Sync beacon locked` : hasSlot ? "Beacon lost" : "Waiting for beacon",
      };
    } else if (hubServerTimer) {
      const liveDbm = Array.isArray(hubGate?.lastRssi) ? hubGate!.lastRssi!.slice(0, 8).map((v) => Math.round(v)) : undefined;
      hub = {
        populated: true,
        online: Boolean(hubServerTimer.online),
        label: hubServerTimer.timerLabel || "H1",
        fp: hubServerTimer.fingerprint || "—",
        fw: hubServerTimer.firmwareVersion || "—",
        mac: knownHub?.mac || "—",
        ch: 1,
        viaUsb: false,
        emergencyMode: false,
        gateLabel: hubGateName,
        serverFrames: hubGate?.framesRxCount ?? 0,
        dbm: liveDbm,
        statusNote: this.store.simulatorRunning ? "Simulated Hub" : hubServerTimer.online ? "Detected on engine" : "Offline",
      };
    } else if (knownHub) {
      hub = {
        populated: true,
        online: false,
        label: knownHub.label || "H1",
        fp: knownHub.fp,
        fw: knownHub.fw || "—",
        mac: knownHub.mac || "—",
        ch: 1,
        viaUsb: false,
        emergencyMode: false,
        gateLabel: hubGateName,
        serverFrames: hubGate?.framesRxCount ?? 0,
        statusNote: "Disconnected · Known Hub",
      };
    } else {
      hub = {
        populated: false,
        online: false,
        label: "H1",
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
    const usedFps = new Set<string>();
    if (hub.fp && hub.fp !== "—") {
      usedFps.add(hub.fp.toUpperCase());
    }

    // 1. If connected to a Hub over USB, populate from Hub's `s.spokes`
    if (s && s.role === 1 && Array.isArray(s.spokes)) {
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
          const gate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === sp.slot);
          const gateName = gate ? (gate.name?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
          const sourceNote =
            frames === 0
              ? `Joined · 0 frames rx`
              : sp.msAgo !== undefined && sp.msAgo >= 2500
                ? `Stale (${(sp.msAgo / 1000).toFixed(1)}s ago)`
                : `${ratePktPerSec.toFixed(1)} pkt/s · ${frames} frames`;
          spokes.set(sp.slot, {
            slot: sp.slot,
            populated: true,
            espNowActive: activelyReceiving,
            inHubStatus: true,
            viaUsb: false,
            label: sp.label || known?.label || `S${sp.slot - 1}`,
            fp,
            fw: sp.fw || known?.fw || s.fw,
            mac: sp.mac || known?.mac,
            frames,
            msAgo: sp.msAgo,
            seq: sp.seq,
            dbm: sp.dbm,
            ratePktPerSec,
            serverFrames: gate?.framesRxCount ?? 0,
            serverGateLabel: gateName,
            serverRssi: Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined,
            sourceNote,
          });
          if (!isFallbackFp && rawFp) usedFps.add(rawFp);
        }
      }
    }

    // 2. If connected to a Spoke over USB, populate its slot directly
    if (s && s.role === 2) {
      const slotNum = s.slot >= 2 && s.slot <= 7 ? s.slot : 2;
      const beaconMsAgo = s.beaconMsAgo ?? s.hub?.beaconMsAgo;
      const hasSlot = !s.emergencyMode && s.slot >= 2;
      const beaconFresh = beaconMsAgo === undefined || beaconMsAgo < 2500;
      const linked = hasSlot && beaconFresh;
      const gate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === slotNum);
      const gateName = gate ? (gate.name?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
      spokes.set(slotNum, {
        slot: slotNum,
        populated: true,
        espNowActive: linked,
        inHubStatus: linked,
        viaUsb: true,
        label: s.label || `S${slotNum - 1}`,
        fp: s.fp || "—",
        fw: s.fw || "—",
        mac: s.chip?.mac,
        frames: gate?.framesRxCount ?? 0,
        beaconMsAgo,
        dbm: this.live?.dbm?.length === 8 ? this.live.dbm : undefined,
        ratePktPerSec: linked ? 25 : 0,
        serverFrames: gate?.framesRxCount ?? 0,
        serverGateLabel: gateName,
        serverRssi: Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined,
        sourceNote: s.emergencyMode
          ? "Emergency mode · USB-C"
          : linked
            ? `USB-C · Synced (${beaconMsAgo ?? 0} ms)`
            : hasSlot
              ? "USB-C · Beacon lost"
              : "USB-C · Searching for Hub",
      });
      if (s.fp) usedFps.add(s.fp.toUpperCase());
    }

    // 3. Merge detected timers from store (engine / simulator)
    for (const dt of detectedTimers) {
      if (!dt.isHub && dt.timerId >= 2 && dt.timerId <= 7) {
        const fp = (dt.fingerprint || "").toUpperCase();
        const gate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === dt.timerId);
        const gateName = gate ? (gate.name?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
        const serverFrames = gate?.framesRxCount ?? 0;
        const serverRssi = Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined;
        if (spokes.has(dt.timerId)) {
          const cur = spokes.get(dt.timerId)!;
          cur.serverFrames = serverFrames;
          cur.serverGateLabel = gateName;
          cur.serverRssi = serverRssi;
          if (fp && (cur.fp.startsWith("SLOT") || cur.fp.startsWith("53504B"))) {
            cur.fp = fp;
          }
          if (dt.timerLabel && cur.label === `S${dt.timerId - 1}`) {
            cur.label = dt.timerLabel;
          }
          if (fp) usedFps.add(fp);
          continue;
        }
        if (fp && usedFps.has(fp)) continue;
        const known = fp ? knownTimers.find((k) => k.fp === fp) : undefined;
        const serverOnline = Boolean(dt.online && (serverFrames > 0 || this.store.simulatorRunning));
        spokes.set(dt.timerId, {
          slot: dt.timerId,
          populated: true,
          espNowActive: serverOnline,
          inHubStatus: serverOnline,
          viaUsb: false,
          label: dt.timerLabel || known?.label || `S${dt.timerId - 1}`,
          fp: fp || "—",
          fw: dt.firmwareVersion || known?.fw || hub.fw,
          mac: known?.mac,
          frames: serverFrames,
          ratePktPerSec: this.store.simulatorRunning && dt.online ? 25 : 0,
          serverFrames,
          serverGateLabel: gateName,
          serverRssi,
          sourceNote: serverOnline
            ? this.store.simulatorRunning
              ? `Simulating · ${serverFrames} frames`
              : `${serverFrames} samples rx`
            : `Offline · 0 frames rx`,
        });
        if (fp) usedFps.add(fp);
      }
    }

    // 4. Fill remaining slots with known hardware spokes (inactive / dashed)
    if (!this.store.simulatorRunning) {
      const candidateSpokes = knownTimers.filter(
        (k) =>
          k.role === "spoke" &&
          !usedFps.has(k.fp.toUpperCase()) &&
          (!k.parentHubFp || !hub.fp || hub.fp === "—" || k.parentHubFp.toUpperCase() === hub.fp.toUpperCase())
      );
      for (const k of candidateSpokes) {
        let targetSlot = k.slot && k.slot >= 2 && k.slot <= 7 && !spokes.has(k.slot) ? k.slot : 0;
        if (!targetSlot) {
          for (let sl = 2; sl <= 7; sl++) {
            if (!spokes.has(sl)) {
              targetSlot = sl;
              break;
            }
          }
        }
        if (targetSlot >= 2 && targetSlot <= 7) {
          const gate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === targetSlot);
          const gateName = gate ? (gate.name?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
          spokes.set(targetSlot, {
            slot: targetSlot,
            populated: true,
            espNowActive: false,
            inHubStatus: false,
            viaUsb: false,
            label: k.label || `S${targetSlot - 1}`,
            fp: k.fp,
            fw: k.fw || hub.fw,
            mac: k.mac,
            frames: 0,
            ratePktPerSec: 0,
            serverFrames: gate?.framesRxCount ?? 0,
            serverGateLabel: gateName,
            serverRssi: Array.isArray(gate?.lastRssi) ? gate!.lastRssi!.slice(0, 8) : undefined,
            sourceNote: `Inactive · not joined`,
          });
          usedFps.add(k.fp.toUpperCase());
        }
      }
    }

    // 5. Fill any remaining slots (2..7) with empty placeholders
    for (let slotNum = 2; slotNum <= 7; slotNum++) {
      if (!spokes.has(slotNum)) {
        spokes.set(slotNum, {
          slot: slotNum,
          populated: false,
          espNowActive: false,
          inHubStatus: false,
          viaUsb: false,
          label: `S${slotNum - 1}`,
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
    const { hub, spokes } = this.buildTopologyState();
    const sel = this.ensureSelectedSlot(hub, spokes);
    this.renderTopologySection(hub, spokes, sel);
    this.renderTimerSection(hub, spokes, sel);
  }

  private renderSpokeNodeCard(sp: TopologySpokeInfo, isSelected: boolean): string {
    const slotNum = sp.slot;
    if (!sp.populated) {
      return `
        <button type="button" class="debug-topo-node is-spoke is-empty is-inactive-link ${isSelected ? "is-selected" : ""}" data-action="select-topology-slot" data-slot-num="${slotNum}" aria-pressed="${isSelected}" title="TDMA Slot ${slotNum} (Open) — click to view slot details">
          <div class="debug-topo-node-head">
            <span class="debug-topo-slot-tag mono">Slot ${slotNum}</span>
            <span class="note">Open</span>
          </div>
          <div class="debug-topo-node-main">
            <span class="status-dot"></span>
            <strong class="debug-topo-node-label">${esc(sp.label)}</strong>
            <span class="note">· Unassigned</span>
          </div>
          <div class="debug-topo-node-foot">
            <span class="note">Available for Spoke ${esc(sp.label)}</span>
          </div>
        </button>`;
    }

    const active = sp.espNowActive;
    const dotClass = active ? "is-spoke" : sp.inHubStatus ? "is-warn" : "";
    const stateBadgeClass = active ? "badge-good" : sp.inHubStatus ? "badge-warn" : "";
    const stateBadgeText = active ? "ESP-NOW Active" : sp.viaUsb ? "USB-C" : sp.inHubStatus ? "Stale" : "Inactive";

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
          <span>${esc(sp.sourceNote)}</span>
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
        ? `${esc(s.label || "S1")} · Spoke · Emergency mode active`
        : ownSpoke?.espNowActive
          ? `${esc(s.label || "S1")} · Spoke (Slot ${s.slot}) · Synced to Hub ${esc(hub.label)} on 2.4 GHz Ch ${hub.ch}`
          : `${esc(s.label || "S1")} · Spoke · Searching for Hub sync beacon on 2.4 GHz…`;
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
              <strong class="debug-topo-hub-name">${esc(hub.label)}</strong>
              ${hub.fp && hub.fp !== "—" ? `<span class="badge mono">${esc(hub.fp)}</span>` : ""}
            </div>
            <div class="debug-topo-hub-meta">
              <span>${esc(hub.statusNote)}</span>
              <span class="mono">2.4 GHz Ch ${hub.ch} · ${activeCount}/${tiedCount} active</span>
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
      const populatedSpokes = [...spokes.values()].filter((sp) => sp.populated);
      const activeSpokes = populatedSpokes.filter((sp) => sp.espNowActive);
      const ledClass = hub.emergencyMode ? "is-emergency" : hub.online ? "is-up" : hub.populated ? "is-warn" : "";
      const barsHtml = this.renderRssiBars(
        freqs,
        hub.dbm,
        hub.dbm ? (hub.viaUsb ? "Direct via USB-C" : "Engine telemetry") : "Assign Hub to a gate in Track or stream in Debug to view 5.8 GHz readings",
        `5.8 GHz channels at ${esc(hub.label)} (Hub · Slot 1)`
      );

      const timerHtml = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${ledClass}"></span>
            <span class="debug-head-note"><strong>${esc(hub.label)}</strong> · Parent Hub (TDMA Slot 1) · ${esc(hub.statusNote)}</span>
          </span>
          <div class="debug-connect-actions">
            <span class="badge ${hub.online ? "badge-good" : ""}">TDMA Slot 1 · Hub</span>
            ${hub.fp && hub.fp !== "—" ? `<span class="badge mono">${esc(hub.fp)}</span>` : ""}
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
                <dt>Practice gate</dt>
                <dd>${hub.gateLabel ? `${esc(hub.gateLabel)} <span class="note mono">· ${hub.serverFrames ?? 0} samples</span>` : `<span class="note">Unassigned in Track (collector-only mode)</span>`}</dd>
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
            <span class="debug-head-note"><strong>TDMA Slot ${selectedSlot}</strong> · Open child Spoke slot (${esc(sp?.label || `S${selectedSlot - 1}`)})</span>
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
          <span class="debug-net-inspector-kpi-label">Practice gate &amp; engine rx</span>
          <strong class="debug-net-inspector-kpi-val">${sp.serverGateLabel ? `${esc(sp.serverGateLabel)} <span class="note mono">· ${sp.serverFrames ?? 0} samples</span>` : `<span class="note">Unassigned in Track</span>`}</strong>
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
