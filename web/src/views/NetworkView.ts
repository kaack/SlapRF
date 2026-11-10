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

/**
 * Dedicated Network page (`#/network`):
 * Inspect the 2.4 GHz TDMA network topology (Parent Hub Slot 1 + Child Spokes Slots 2–7, with live Spoke RSSI inspector).
 */
export class NetworkView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly console: TimerConsole;
  private status: TimerStatus | null = null;
  private selectedNetworkSpokeSlot: number | null = null;
  private spokeRateTracker = new Map<number, { frames: number; atMs: number; ratePktPerSec: number }>();
  private signalEnabledCh: boolean[] = [true, true, true, true, true, true, true, true];
  private lastNetHtml = "";

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
            <h2>Network view</h2>
            <p>Shows how the connected timer sits in the 2.4 GHz course network: when connected to a Hub (parent, TDMA slot 1), lists the child Spokes tied to it across TDMA slots 2–7; when connected to a Spoke (child), shows the parent Hub it is synced to.</p>
          </div>
          <div class="debug-status-layout" data-slot="network"></div>
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
        this.renderNetworkView();
      },
      onConfig: () => {
        this.renderNetworkView();
      },
      onDisconnect: () => {
        this.status = null;
        this.renderAll();
      },
    });

    const unsubState = this.console.onStateChange(() => {
      this.renderNetworkView();
    });

    const unsubBridge = this.api.hubBridge.subscribe(() => {
      this.renderNetworkView();
    });

    const unsubStore = this.store.subscribe(["status", "config"], () => {
      this.syncKnownTimersFromStore();
      this.renderNetworkView();
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

  private loadPrefs(): void {
    try {
      const raw = window.localStorage.getItem(NETWORK_PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(p.signalEnabledCh) && p.signalEnabledCh.length === 8) {
        this.signalEnabledCh = p.signalEnabledCh.map(Boolean);
      }
      if (typeof p.selectedNetworkSpokeSlot === "number" && p.selectedNetworkSpokeSlot >= 2 && p.selectedNetworkSpokeSlot <= 7) {
        this.selectedNetworkSpokeSlot = p.selectedNetworkSpokeSlot;
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
          selectedNetworkSpokeSlot: this.selectedNetworkSpokeSlot,
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
    if (t.dataset.action === "select-net-spoke") {
      const slotNum = Number(t.dataset.spokeSlot);
      if (slotNum >= 2 && slotNum <= 7) {
        this.selectedNetworkSpokeSlot = slotNum;
        this.renderNetworkView();
        this.savePrefs();
      }
    }
  }

  private renderAll(): void {
    this.renderNetworkView();
  }

  private renderNetworkView(): void {
    const s = this.activeStatus();
    const on = s !== null;
    const viaLabel = "USB-C";
    const knownTimers = getKnownHardwareTimers();
    const realServerTimers: DetectedTimer[] = !this.store.simulatorRunning
      ? this.store.detectedTimers.filter((t) => !(t.fingerprint || "").toUpperCase().startsWith("SIM000"))
      : [];

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

      const emptyHtml = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${this.console.connected ? "is-warn" : ""}"></span>
            <span class="debug-head-note">${this.console.connected ? "Reading timer network role…" : "Off · click Connect in the top bar to inspect parent/child network links"}</span>
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
      if (emptyHtml !== this.lastNetHtml) {
        this.lastNetHtml = emptyHtml;
        this.slot("network").innerHTML = emptyHtml;
      }
      return;
    }

    const ch = s.channel || 1;

    if (s.role === 1) {
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
              label: sp.label || known?.label || `S${sp.slot - 1}`,
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

      for (const dt of realServerTimers) {
        if (!dt.isHub && dt.timerId >= 2 && dt.timerId <= 7) {
          const fp = (dt.fingerprint || "").toUpperCase();
          const gate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === dt.timerId);
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
            if (dt.timerLabel && cur.label === `S${dt.timerId - 1}`) {
              cur.label = dt.timerLabel;
            }
            if (fp) usedFps.add(fp);
            continue;
          }
          if (fp && usedFps.has(fp)) continue;
          const known = fp ? knownTimers.find((k) => k.fp === fp) : undefined;
          const serverOnline = Boolean(dt.online && serverFrames > 0);
          bySlot.set(dt.timerId, {
            slot: dt.timerId,
            fp: fp || "—",
            label: dt.timerLabel || known?.label || `S${dt.timerId - 1}`,
            fw: dt.firmwareVersion || known?.fw || s.fw,
            mac: known?.mac,
            online: serverOnline,
            inHubStatus: false,
            frames: serverFrames,
            ratePktPerSec: 0,
            serverFrames,
            serverGateLabel: gateName,
            serverRssi,
            sourceNote: serverOnline ? `${serverFrames} samples on engine` : `0 frames rx · not heard by Hub`,
          });
          if (fp) usedFps.add(fp);
        }
      }

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
          const gate = this.store.nodes.find((g) => (g.assignedTimerId ?? g.gateId) === targetSlot);
          const gateName = gate ? (gate.name?.trim() || gate.timerLabel?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
          bySlot.set(targetSlot, {
            slot: targetSlot,
            fp: k.fp,
            label: k.label || `S${targetSlot - 1}`,
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
                <span class="status-dot ${child.online ? "is-spoke" : "is-warn"}"></span>
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

        inspectorHtml = `
          <div class="debug-net-spoke-inspector" data-spoke-inspector="${selectedChild.slot}">
            <div class="debug-net-inspector-head">
              <div class="debug-net-inspector-title">
                <span class="status-dot ${selectedChild.online ? "is-spoke" : "is-warn"}"></span>
                <strong>${esc(selectedChild.label)}</strong>
                <span class="note">· TDMA Slot ${selectedChild.slot} live stream at ${esc(s.label || "Hub")}</span>
              </div>
              <div class="debug-connect-actions">
                <span class="badge ${selectedChild.online ? "badge-good" : "badge-warn"} mono">${rate.toFixed(1)} pkt/s</span>
                <span class="badge mono">${frames} frames rx</span>
                <span class="badge mono">${esc(selectedChild.fp)}</span>
              </div>
            </div>
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
                <span class="debug-net-inspector-kpi-label">Practice gate &amp; engine rx</span>
                <strong class="debug-net-inspector-kpi-val">${selectedChild.serverGateLabel ? `${esc(selectedChild.serverGateLabel)} <span class="note mono">· ${selectedChild.serverFrames ?? 0} samples</span>` : `<span class="note">Unassigned in Track</span>`}</strong>
              </div>
            </div>
            <div class="debug-net-inspector-bars-wrap">
              <div class="debug-subbar">
                <span class="debug-chart-title">5.8 GHz channels received from ${esc(selectedChild.label)} (Slot ${selectedChild.slot})</span>
                <span class="note mono">${dbmSource ? `Direct via Hub (${viaLabel})` : "Waiting for Spoke window frames…"}</span>
              </div>
              <div class="debug-net-inspector-bars">${barsHtml}</div>
            </div>
          </div>`;
      }

      const hubNetHtml = `
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
              <span class="badge badge-good">Slot 1 · ${viaLabel}</span>
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
      if (hubNetHtml !== this.lastNetHtml) {
        this.lastNetHtml = hubNetHtml;
        this.slot("network").innerHTML = hubNetHtml;
      }
      return;
    }

    // Connected device is a Spoke (Child, Role 2): show Current Spoke (Blue LED) + Link Bridge + Parent Hub (Slot 1).
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

    const ledClass = s.emergencyMode ? "is-emergency" : "is-spoke";
    const topText = s.emergencyMode
      ? `${esc(s.label || "S1")} · Spoke (Child) · Emergency mode active (2.4 GHz link paused)`
      : linked
        ? `${esc(s.label || "S1")} · Spoke (Child · TDMA Slot ${s.slot}) · Tied to Parent Hub ${esc(parentLabel)} (Slot 1) on 2.4 GHz Ch ${ch}${beaconMsAgo !== undefined ? ` · beacon ${beaconMsAgo} ms ago` : ""}`
        : beaconStale
          ? `${esc(s.label || "S1")} · Spoke (Slot ${s.slot}) · Hub sync beacon lost (${((beaconMsAgo ?? 0) / 1000).toFixed(1)}s ago) — out of phase or Hub offline`
          : `${esc(s.label || "S1")} · Spoke (Child) · Searching for Parent Hub sync beacon on 2.4 GHz…`;

    const spokeNetHtml = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="debug-head-note">${topText}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge badge-accent">${linked ? `Child Spoke · Slot ${s.slot}` : beaconStale ? `Beacon Lost · Slot ${s.slot}` : "Child Spoke · Searching"}</span>
          <span class="badge mono">Parent: ${esc(parentLabel)} (Slot 1)</span>
        </div>
      </div>
      <div class="debug-network-panels is-spoke-view">
        <div class="debug-subbox debug-net-self-card">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title is-active">${icons.cpu(14)}<span>Current device · Spoke (Child)</span></span>
            <span class="badge badge-accent">${s.slot >= 2 ? `Slot ${s.slot} · USB-C` : "USB-C connected"}</span>
          </div>
          <div class="debug-net-node-banner is-spoke">
            <div class="debug-net-node-main">
              <span class="debug-net-role-tag is-spoke">SPOKE · CHILD</span>
              <strong class="debug-net-node-name">${esc(s.label || "S1")}</strong>
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
            <span class="debug-net-bridge-end mono">${esc(s.label || "S1")} (${hasSlot ? `Slot ${s.slot}` : "Child"})</span>
            <span class="debug-net-bridge-line"></span>
            <span class="debug-net-bridge-arrow">${icons.arrowRight(14)}</span>
            <span class="debug-net-bridge-end mono">${esc(parentLabel)} (Slot 1)</span>
          </div>
          <span class="note">${linked ? `Beacon synced (${beaconMsAgo ?? 0} ms ago) · 4-sweep windows → ${esc(parentLabel)}` : beaconStale ? `Beacon lost (${((beaconMsAgo ?? 0) / 1000).toFixed(1)}s ago) — power-cycle or reflash Spoke` : "Waiting for Hub beacon & ASSIGN frame…"}</span>
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
    if (spokeNetHtml !== this.lastNetHtml) {
      this.lastNetHtml = spokeNetHtml;
      this.slot("network").innerHTML = spokeNetHtml;
    }
  }
}
