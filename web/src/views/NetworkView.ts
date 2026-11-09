import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { ConnectivityMethod } from "../services/browser_hub_bridge";
import { FIRMWARE_PROFILES } from "../services/esp_flasher";
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
 * 1. Connect to a Hub or Spoke timer via Direct USB-C (WebSerial) or Wi-Fi Stream (SSE `/api/hub-stream`).
 * 2. Inspect the 2.4 GHz TDMA network topology (Parent Hub Slot 1 + Child Spokes Slots 2–7, with live Spoke RSSI inspector).
 * 3. View & toggle the 8 monitored 5.8 GHz pilot channels and live RSSI meters.
 */
export class NetworkView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly console: TimerConsole;
  private status: TimerStatus | null = null;
  private live: LiveSample | null = null;
  private liveOn = false;
  private showAllPorts = false;
  private error: string | null = null;
  private selectedNetworkSpokeSlot: number | null = null;
  private spokeRateTracker = new Map<number, { frames: number; atMs: number; ratePktPerSec: number }>();
  private signalEnabledCh: boolean[] = [true, true, true, true, true, true, true, true];
  private chanMaskToggledAt = 0;
  private barFillVal: number[] = [-127, -127, -127, -127, -127, -127, -127, -127];
  private barFillAt: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  private barPeakVal: number[] = [-127, -127, -127, -127, -127, -127, -127, -127];
  private barPeakAt: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    this.console = sharedTimerConsole;
    this.loadPrefs();
    this.console.showAllPorts = this.showAllPorts;
    if (this.console.connected && this.console.lastStatus) {
      this.status = this.console.lastStatus;
    }

    el.innerHTML = `
      <div class="settings debug-page network-page">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Connectivity</h2>
            <p>Connect to a timer over Direct USB-C or over Wi-Fi to inspect the 2.4 GHz course network and monitored 5.8 GHz channels.</p>
          </div>
          <div class="debug-status-layout" data-slot="connection"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Network view</h2>
            <p>Shows how the connected timer sits in the 2.4 GHz course network: when connected to a Hub (parent, TDMA slot 1), lists the child Spokes tied to it across TDMA slots 2–7; when connected to a Spoke (child), shows the parent Hub it is synced to.</p>
          </div>
          <div class="debug-status-layout" data-slot="network"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Monitored channels</h2>
            <p>The 8 pilot channels monitored in each timing sweep (synced from active pilots). Click any channel row to toggle monitoring on or off—fewer active channels make each sweep faster. Click <strong>Stream</strong> to inspect live 5.8 GHz channel bars.</p>
          </div>
          <div class="debug-status-layout">
            <div data-slot="live-head"></div>
            <div class="debug-subbox" data-slot="live"></div>
          </div>
        </section>
      </div>`;

    const unsubConsole = this.console.subscribe({
      onConnect: () => {
        this.error = null;
        this.renderAll();
      },
      onStatus: (s) => {
        const freqsChanged = this.status?.freqs.join() !== s.freqs.join();
        this.status = s;
        if (s.chanMask !== undefined && Date.now() - this.chanMaskToggledAt > 1500) {
          const nextEnabled = Array.from({ length: 8 }, (_, i) => ((s.chanMask! >> i) & 1) !== 0);
          if (nextEnabled.join() !== this.signalEnabledCh.join()) {
            this.signalEnabledCh = nextEnabled;
          }
        }
        if (s.emergencyMode) {
          this.liveOn = false;
        }
        this.renderConnection();
        this.renderNetworkView();
        this.renderLiveHead();
        if (freqsChanged) {
          this.renderLive();
        } else {
          this.updateLive();
        }
      },
      onLive: (s) => {
        this.live = s;
        this.updateLive();
      },
      onConfig: () => {
        this.renderNetworkView();
      },
      onError: (msg) => {
        this.error = msg;
        this.renderConnection();
      },
      onDisconnect: () => {
        this.status = null;
        this.liveOn = false;
        this.renderAll();
      },
    });

    const unsubState = this.console.onStateChange(() => {
      this.renderConnection();
    });

    const unsubBridge = this.api.hubBridge.subscribe(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.name === "hubHost" && this.el.contains(active)) {
        return;
      }
      if (!this.console.connected && this.api.hubBridge.wifiState === "connected") {
        const dbm = this.api.hubBridge.wifiLastDbm;
        this.live = {
          us: 11200,
          dbm,
          pk: dbm,
        };
      }
      this.renderConnection();
      this.renderNetworkView();
      this.renderLiveHead();
      this.updateLive();
    });

    const unsubStore = this.store.subscribe(["status", "config"], () => {
      this.syncKnownTimersFromStore();
      this.renderNetworkView();
    });

    this.listen(el, "click", (e) => void this.onClick(e));
    this.listen(el, "dblclick", (e) => {
      const bar = (e.target as HTMLElement).closest<HTMLElement>("[data-bar]");
      if (!bar) return;
      const idx = Number(bar.dataset.ch);
      if (idx >= 0 && idx < 8) {
        const onlyThisOn = this.signalEnabledCh.every((on, i) => (i === idx ? on : !on));
        this.signalEnabledCh = this.signalEnabledCh.map((_, i) => (onlyThisOn ? true : i === idx));
        this.syncChannelMaskToFirmware();
        this.updateLive();
        this.savePrefs();
      }
    });
    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-all-ports]")) {
        this.showAllPorts = t.checked;
        this.console.showAllPorts = t.checked;
        this.savePrefs();
      } else if (t.name === "hubHost") {
        this.api.hubBridge.setHubHost(t.value, false);
      }
    });
    this.listen(el, "keydown", (e) => {
      const ke = e as KeyboardEvent;
      const t = ke.target as HTMLInputElement;
      if (t && t.name === "hubHost" && ke.key === "Enter") {
        ke.preventDefault();
        this.api.hubBridge.setHubHost(t.value, true);
        this.api.hubBridge.connectWifiStream(true);
      }
    });

    this.onDispose(() => {
      unsubConsole();
      unsubState();
      unsubBridge();
      unsubStore();
      if (this.console.connected && this.liveOn) {
        void this.console.send("LIVE 0").catch(() => undefined);
      }
    });

    this.syncKnownTimersFromStore();
    this.renderAll();
  }

  private loadPrefs(): void {
    try {
      const raw = window.localStorage.getItem(NETWORK_PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Record<string, unknown>;
      if (typeof p.showAllPorts === "boolean") this.showAllPorts = p.showAllPorts;
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
          showAllPorts: this.showAllPorts,
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
    for (const dt of this.store.timers) {
      const fp = (dt.fingerprint || "").toUpperCase();
      if (fp && fp !== "00000001" && !fp.startsWith("SIM000")) {
        const prof = FIRMWARE_PROFILES.find((p) => p.id === dt.firmwareProfile);
        recordKnownHardwareTimer({
          fp,
          role: dt.isHub ? "hub" : "spoke",
          label: dt.timerLabel,
          profile: prof?.code ?? 1,
          fw: dt.firmwareVersion,
          slot: dt.timerId >= 1 && dt.timerId <= 7 ? dt.timerId : undefined,
        });
      }
    }
  }

  private syncChannelMaskToFirmware(): void {
    this.chanMaskToggledAt = Date.now();
    let mask = 0;
    for (let i = 0; i < 8; i++) {
      if (this.signalEnabledCh[i]) mask |= 1 << i;
    }
    if (this.console.connected) {
      void this.console.send(`CHANNELS MASK ${mask}`).catch(() => undefined);
    }
  }

  private activeStatus(): TimerStatus | null {
    if (this.console.connected && this.status) {
      return this.status;
    }
    if (this.api.hubBridge.wifiState === "connected" && this.api.hubBridge.wifiStatus) {
      const st = { ...this.api.hubBridge.wifiStatus };
      const pilotFreqs = this.store.pilots.slice(0, 8).map((p) => p.frequencyMhz);
      if (pilotFreqs.length === 8) {
        st.freqs = pilotFreqs;
      }
      return st;
    }
    return null;
  }

  private async onClick(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    this.error = null;
    try {
      switch (t.dataset.action) {
        case "conn-method": {
          const method = t.dataset.method as ConnectivityMethod | undefined;
          if (method === "usb" || method === "wifi") {
            this.api.hubBridge.setConnMethod(method);
            this.renderConnection();
          }
          break;
        }
        case "usb-connect":
          await this.console.connectAndStart(this.showAllPorts);
          break;
        case "usb-disconnect":
          this.liveOn = false;
          await this.console.disconnectCleanly();
          break;
        case "wifi-discover": {
          const inp = this.el.querySelector<HTMLInputElement>('input[name="hubHost"]');
          if (inp && inp.value.trim()) {
            this.api.hubBridge.setHubHost(inp.value, false);
          }
          await this.api.hubBridge.discoverHub();
          break;
        }
        case "wifi-connect": {
          const inp = this.el.querySelector<HTMLInputElement>('input[name="hubHost"]');
          if (inp && inp.value.trim()) {
            this.api.hubBridge.setHubHost(inp.value, false);
          }
          this.api.hubBridge.connectWifiStream(true);
          break;
        }
        case "wifi-disconnect":
          this.api.hubBridge.disconnectWifiStream();
          break;
        case "reset-hub-host":
          this.api.hubBridge.setHubHost("192.168.4.1", false);
          break;
        case "select-net-spoke": {
          const slotNum = Number(t.dataset.spokeSlot);
          if (slotNum >= 2 && slotNum <= 7) {
            this.selectedNetworkSpokeSlot = slotNum;
            this.renderNetworkView();
            this.savePrefs();
          }
          break;
        }
        case "rf": {
          if (!this.console.connected) break;
          const on = !(this.status?.rf.enabled ?? true);
          if (!on && !confirm("Switch the 5.8 GHz receiver off? The timer stops timing until you switch it back on or restart it.")) {
            break;
          }
          await this.console.request(`RF ${on ? 1 : 0}`, "ok", 2000);
          const next = await this.console.request<TimerStatus>("STATUS?", "status", 2000).catch(() => null);
          if (next) this.status = next;
          this.renderLiveHead();
          break;
        }
        case "live": {
          if (!this.console.connected) break;
          this.liveOn = !this.liveOn;
          await this.console.send(this.liveOn ? "LIVE 1" : "LIVE 0");
          this.renderLiveHead();
          break;
        }
        case "signal-ch": {
          const idx = Number(t.dataset.ch);
          if (idx >= 0 && idx < 8) {
            this.signalEnabledCh[idx] = !this.signalEnabledCh[idx];
            this.syncChannelMaskToFirmware();
            this.updateLive();
            this.savePrefs();
          }
          break;
        }
        case "restore-live-channels":
          this.signalEnabledCh = [true, true, true, true, true, true, true, true];
          this.syncChannelMaskToFirmware();
          this.updateLive();
          this.savePrefs();
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|cancel/i.test(msg)) {
        this.error = msg;
      }
    }
    this.renderConnection();
  }

  private renderAll(): void {
    this.renderConnection();
    this.renderNetworkView();
    this.renderLiveHead();
    this.renderLive();
  }

  private renderConnection(): void {
    const hub = this.api.hubBridge;
    const method = hub.connMethod;
    const led = hub.getLedSummary();
    const usbOn = this.console.connected;
    const usbSupported = TimerConsole.supported();
    const usbBusy = Boolean(this.console.busyLabel || this.console.reconnecting);
    const s = this.activeStatus();
    const profile = s ? FIRMWARE_PROFILES.find((p) => p.code === s.profile) : undefined;

    const dotClass =
      led.color === "neon"
        ? "is-up"
        : led.color === "blue"
          ? "is-spoke"
          : led.color === "yellow"
            ? "is-warn"
            : led.color === "red"
              ? "is-bad"
              : "";

    let statusText = "Disconnected · choose Direct USB-C or Wi-Fi Stream below to connect";
    if (usbOn && this.status) {
      const st = this.status;
      statusText = st.emergencyMode
        ? `${esc(st.label || "(unnamed)")} · Emergency mode · radio & sweeps halted · ${esc(st.fp)}`
        : `${esc(st.label || "(unnamed)")} · ${st.role === 1 ? "Hub (Parent · Slot 1)" : `Spoke (Child · Slot ${st.slot || "?"})`} · ${esc(profile?.name ?? `Profile ${st.profile}`)} · ${esc(st.fp)} · Direct USB-C`;
    } else if (usbOn) {
      statusText = "Connected over Direct USB-C · reading timer identity…";
    } else if (this.console.reconnecting) {
      statusText = `Lost USB connection · trying to reconnect (${this.console.reconnectAttempt}/${this.console.maxReconnectAttempts})…`;
    } else if (hub.wifiState === "connected") {
      const hubLabel = s?.label || "H1";
      statusText = `${esc(hubLabel)} · Hub (Parent · Slot 1) · Wi-Fi Stream (${esc(hub.hubHost)}) · ${hub.wifiFramesRx.toLocaleString()} frames rx`;
    } else if (hub.wifiState === "connecting" || hub.wifiState === "reconnecting") {
      statusText =
        hub.wifiReconnectAttempt > 0
          ? `Lost Wi-Fi connection · trying to reconnect to ${esc(hub.hubHost)} (${hub.wifiReconnectAttempt}/${hub.maxReconnectAttempts})…`
          : `Connecting to Hub over Wi-Fi at http://${esc(hub.hubHost)}/api/hub-stream…`;
    } else if (led.color === "red") {
      statusText = esc(hub.wifiError || this.console.lastError || "All reconnect attempts failed.");
    }

    const isCustomHost = hub.hubHost !== "192.168.4.1";
    const wifiConnected = hub.wifiState === "connected" || hub.wifiState === "connecting" || hub.wifiState === "reconnecting";

    let methodBodyHtml = "";
    if (method === "usb") {
      const usbBtnLabel = usbOn
        ? this.status?.label
          ? `Disconnect · ${esc(this.status.label)}`
          : "Disconnect USB"
        : this.console.reconnecting
          ? `Reconnecting (${this.console.reconnectAttempt}/${this.console.maxReconnectAttempts})…`
          : this.console.busyLabel
            ? `${esc(this.console.busyLabel)}…`
            : "Connect USB-C";
      methodBodyHtml = `
        <div class="option-row">
          <div>
            <div class="option-title">Direct USB-C connection</div>
            <div class="option-sub">Plug a Hub or Spoke timer into this computer over USB-C to automatically detect its role, TDMA slot, and peer timers.</div>
          </div>
          <div class="debug-connect-actions">
            ${
              !usbOn
                ? `<label class="check debug-port-filter">
                    <input type="checkbox" data-all-ports ${this.showAllPorts ? "checked" : ""}/>
                    <span>Show non-XIAO ports</span>
                  </label>`
                : ""
            }
            <button type="button" class="btn btn-sm ${usbOn ? "btn-armed" : "btn-unarmed"}" data-action="${usbOn ? "usb-disconnect" : "usb-connect"}" ${usbSupported && !usbBusy ? "" : "disabled"}>
              ${usbOn ? icons.plug(14) : icons.plugOff(14)}<span>${usbBtnLabel}</span>
            </button>
          </div>
        </div>
        ${!usbSupported ? `<div class="sim-error-note" style="margin-top:8px;">Direct USB-C requires Chrome, Edge, or Brave (WebSerial). Use Wi-Fi Stream on other browsers.</div>` : ""}`;
    } else {
      methodBodyHtml = `
        <div class="option-row">
          <div>
            <div class="option-title">Wi-Fi Hub stream</div>
            <div class="option-sub">Connects directly over Wi-Fi to your Hub's real-time stream (<code>http://${esc(hub.hubHost)}/api/hub-stream</code>). Join the Hub's <code>SlapRF</code> Wi-Fi AP (<code>192.168.4.1</code>) or enter its LAN IP address.</div>
          </div>
          <div class="debug-connect-actions" style="flex-wrap:wrap;">
            <div class="flasher-pass-wrap has-inline-action" style="width:170px;">
              <input
                class="input mono ${isCustomHost ? "flasher-pass-input" : ""}"
                style="height:28px;font-size:12px;"
                type="text"
                name="hubHost"
                value="${esc(hub.hubHost)}"
                placeholder="192.168.4.1"
                aria-label="Hub IP address or hostname"
              />
              ${
                isCustomHost
                  ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-action="reset-hub-host" title="Reset Hub address to 192.168.4.1">${icons.reset(14)}</button>`
                  : ""
              }
            </div>
            <button type="button" class="btn btn-sm btn-ghost" data-action="wifi-discover" ${hub.discovering ? "disabled" : ""}>
              ${hub.discovering ? "Scanning…" : "Discover Hub"}
            </button>
            <button type="button" class="btn btn-sm ${hub.wifiState === "connected" ? "btn-armed" : "btn-unarmed"}" data-action="${wifiConnected ? "wifi-disconnect" : "wifi-connect"}">
              ${icons.wifi(14)}<span>${hub.wifiState === "connected" ? `Disconnect · ${esc(hub.hubHost)}` : wifiConnected ? "Cancel" : "Connect Wi-Fi"}</span>
            </button>
          </div>
        </div>`;
    }

    this.slot("connection").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${dotClass}"></span>
          <span class="debug-head-note">${statusText}</span>
        </span>
        <div class="debug-connect-actions">
          <div class="segmented" role="group" aria-label="Connectivity method">
            <button type="button" class="${method === "usb" ? "is-active" : ""}" data-action="conn-method" data-method="usb">Direct USB-C</button>
            <button type="button" class="${method === "wifi" ? "is-active" : ""}" data-action="conn-method" data-method="wifi">Wi-Fi Stream</button>
          </div>
        </div>
      </div>
      <div class="debug-subbox">
        ${methodBodyHtml}
        ${this.error ? `<div class="sim-error-note" style="margin-top:8px;">${esc(this.error)}</div>` : ""}
      </div>`;
  }

  private renderNetworkView(): void {
    const s = this.activeStatus();
    const on = s !== null;
    const viaLabel = this.console.connected ? "USB-C" : "Wi-Fi";
    const knownTimers = getKnownHardwareTimers();
    const realServerTimers: DetectedTimer[] = !this.store.simulatorRunning
      ? this.store.timers.filter((t) => !(t.fingerprint || "").toUpperCase().startsWith("SIM000"))
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

      this.slot("network").innerHTML = `
        <div class="debug-status-topbar">
          <span class="debug-led-status">
            <span class="status-dot ${this.console.connected ? "is-warn" : ""}"></span>
            <span class="debug-head-note">${this.console.connected ? "Reading timer network role…" : "Off · connect a Hub or Spoke above to inspect its parent/child network links"}</span>
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
                <dt>Profile &amp; schedule</dt>
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

    const profile = FIRMWARE_PROFILES.find((p) => p.code === s.profile);
    const profileName = profile?.name ?? `Profile ${s.profile}`;
    const ch = s.channel || 1;

    if (s.role === 1) {
      interface TiedSpokeEntry {
        slot: number;
        fp: string;
        label: string;
        profileName: string;
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
            const spProf = FIRMWARE_PROFILES.find((p) => p.code === (sp.profile ?? s.profile));
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
              profileName: spProf?.name ?? profileName,
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
          const gate = this.store.gates.find((g) => g.assignedTimerId === dt.timerId);
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
          const spProf = FIRMWARE_PROFILES.find((p) => p.id === dt.firmwareProfile);
          const serverOnline = Boolean(dt.online && serverFrames > 0);
          bySlot.set(dt.timerId, {
            slot: dt.timerId,
            fp: fp || "—",
            label: dt.timerLabel || known?.label || `S${dt.timerId - 1}`,
            profileName: spProf?.name ?? profileName,
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
          (!k.parentHubFp || k.parentHubFp.toUpperCase() === s.fp.toUpperCase()) &&
          k.profile === s.profile
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
          const spProf = FIRMWARE_PROFILES.find((p) => p.code === k.profile);
          const gate = this.store.gates.find((g) => g.assignedTimerId === targetSlot);
          const gateName = gate ? (gate.name?.trim() || gate.timerLabel?.trim() || `Gate ${gate.trackOrder + 1}`) : undefined;
          bySlot.set(targetSlot, {
            slot: targetSlot,
            fp: k.fp,
            label: k.label || `S${targetSlot - 1}`,
            profileName: spProf?.name ?? profileName,
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
                <dd>Slot 1 <span class="note">· Beacon master &amp; SSE bridge</span></dd>
              </div>
              <div class="debug-kv-row">
                <dt>2.4 GHz link</dt>
                <dd>ESP-NOW LR (500 kbps) <span class="note">· Ch ${ch}</span></dd>
              </div>
              <div class="debug-kv-row">
                <dt>Wi-Fi network</dt>
                <dd>${s.net ? `${esc(s.net.mode)} <span class="note">· ${s.net.stations} client${s.net.stations === 1 ? "" : "s"} joined</span>` : `Channel ${ch}`}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Child Spokes tied</dt>
                <dd>${tiedCount > 0 ? `${tiedCount} Spoke${tiedCount === 1 ? "" : "s"} (${[...bySlot.values()].map((c) => esc(c.label)).join(", ")})` : "None yet (listening for JOIN frames)"}</dd>
              </div>
              <div class="debug-kv-row">
                <dt>Profile &amp; MAC</dt>
                <dd>${esc(profileName)} <span class="note mono">· ${esc(s.chip?.mac || "—")}</span></dd>
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

    // Connected device is a Spoke (Child, Role 2): show Current Spoke (Blue LED) + Link Bridge + Parent Hub (Slot 1).
    const selfKnown = knownTimers.find((k) => k.fp.toUpperCase() === s.fp.toUpperCase());
    const serverHub = realServerTimers.find((t) => t.isHub);
    const knownHub =
      (s.hub?.fp ? knownTimers.find((k) => k.fp.toUpperCase() === s.hub!.fp!.toUpperCase()) : undefined) ??
      (selfKnown?.parentHubFp ? knownTimers.find((k) => k.fp.toUpperCase() === selfKnown.parentHubFp!.toUpperCase()) : undefined) ??
      (serverHub?.fingerprint ? knownTimers.find((k) => k.fp.toUpperCase() === serverHub.fingerprint!.toUpperCase()) : undefined) ??
      knownTimers.find((k) => k.role === "hub" && k.profile === s.profile) ??
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
    const parentProf = FIRMWARE_PROFILES.find((p) => p.code === (s.hub?.profile ?? knownHub?.profile ?? s.profile));
    const parentProfileName = parentProf?.name ?? profileName;

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

    this.slot("network").innerHTML = `
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
              <dt>Firmware &amp; profile</dt>
              <dd>${esc(profileName)} <span class="note mono">· ${esc(s.fw)}</span></dd>
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
              <dt>Firmware &amp; profile</dt>
              <dd>${esc(parentProfileName)} <span class="note mono">· ${esc(parentFw)}</span></dd>
            </div>
          </dl>
        </div>
      </div>`;
  }

  private renderLiveHead(): void {
    const usbOn = this.console.connected;
    const wifiOn = !usbOn && this.api.hubBridge.wifiState === "connected";
    const s = this.activeStatus();
    const emg = Boolean(usbOn && this.status?.emergencyMode);
    const rfOn = s?.rf.enabled ?? true;
    const streamDisabled = !usbOn || !rfOn || emg;
    const streamActive = wifiOn || (!streamDisabled && this.liveOn);
    const ledClass = emg
      ? "is-emergency"
      : streamActive
        ? s?.role === 2
          ? "is-spoke"
          : "is-up"
        : usbOn && !rfOn
          ? "is-warn"
          : "";

    this.slot("live-head").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}" data-live-led></span>
          <span class="debug-head-note" data-live-note>${
            emg
              ? "Emergency mode · 5.8 GHz receiver & sweeps halted"
              : wifiOn
                ? "Streaming live 5.8 GHz readings via Hub Wi-Fi SSE"
                : usbOn
                  ? this.liveOn
                    ? "Streaming · waiting for sweeps…"
                    : "Paused · click Stream to view live 5.8 GHz readings"
                  : "Paused · not connected"
          }</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm ${rfOn ? "btn-armed" : "btn-unarmed"}" data-action="rf" ${usbOn && this.status && !emg ? "" : "disabled"} title="Switch the hardware 5.8 GHz receiver on or off">
            ${rfOn ? icons.signal(14) : icons.signalOff(14)}<span>${rfOn ? "Receiver on" : "Receiver off"}</span>
          </button>
          <button type="button" class="btn btn-sm ${streamActive ? "btn-armed" : "btn-unarmed"}" data-action="live" ${streamDisabled ? "disabled" : ""} title="${usbOn ? (this.liveOn ? "Pause live 5.8 GHz readings" : "Stream live 5.8 GHz readings") : "Connect over Direct USB-C to toggle USB channel stream"}">
            ${streamActive ? icons.pause(14) : icons.play(14)}<span>${streamActive ? "Pause" : "Stream"}</span>
          </button>
        </div>
      </div>`;
    this.updateLive();
  }

  private renderLive(): void {
    const s = this.activeStatus();
    const freqs = s?.freqs ?? RACEBAND;
    const activeCount = this.signalEnabledCh.filter(Boolean).length;
    this.slot("live").innerHTML = `
      <div class="debug-subbar">
        <span class="debug-chart-title">Channel RSSI meter (8 pilot slots)</span>
        <span class="note debug-live-ch-hint" data-live-ch-note><span class="mono">${activeCount}/8</span> active · click row to toggle · double-click to solo</span>
      </div>
      <div class="debug-bars">
        ${freqs
          .map((f, i) => {
            const band = racebandName(f) || `Ch${i + 1}`;
            const col = CHANNEL_COLORS[i];
            const onCh = this.signalEnabledCh[i];
            return `
            <div class="debug-bar-row ${onCh ? "" : "is-muted"}" data-bar data-action="signal-ch" data-ch="${i}" role="button" tabindex="0" aria-pressed="${onCh}" title="Click to toggle ${band} (${f} MHz) monitoring on/off · double-click to solo">
              <span class="debug-bar-label mono"><span class="debug-ch-inline" data-bar-dot style="${onCh ? `background:${col}` : `background:transparent;box-shadow:inset 0 0 0 1.5px ${col}`}"></span><strong>${band}</strong> ${f}</span>
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
      <div class="debug-scale mono"><span>${DBM_MIN} dBm</span><span>${DBM_MAX} dBm</span></div>
      <div class="rules-foot">
        <p class="note">Default monitors all 8 pilot channels in every sweep.</p>
        <button class="btn btn-ghost btn-sm" type="button" data-action="restore-live-channels">Restore defaults</button>
      </div>`;
    this.updateLive();
  }

  private updateLive(): void {
    const usbOn = this.console.connected;
    const wifiOn = !usbOn && this.api.hubBridge.wifiState === "connected";
    const on = usbOn || wifiOn;
    const l = (usbOn && this.liveOn) || wifiOn ? this.live : null;
    const note = this.el.querySelector<HTMLElement>("[data-live-note]");
    const led = this.el.querySelector<HTMLElement>("[data-live-led]");
    const chNote = this.el.querySelector<HTMLElement>("[data-live-ch-note]");
    const s = this.activeStatus();
    const emg = Boolean(usbOn && this.status?.emergencyMode);
    const rfOn = s?.rf.enabled ?? true;
    const activeCount = this.signalEnabledCh.filter(Boolean).length;

    if (chNote) {
      chNote.innerHTML = `<span class="mono">${activeCount}/8</span> active · click row to toggle · double-click to solo`;
    }
    if (led) {
      const streaming = !emg && on && rfOn && (wifiOn || this.liveOn);
      led.classList.toggle("is-emergency", emg);
      led.classList.toggle("is-up", streaming && s?.role !== 2);
      led.classList.toggle("is-spoke", streaming && s?.role === 2);
      led.classList.toggle("is-warn", !emg && usbOn && !rfOn);
    }
    if (note) {
      if (!on) {
        note.textContent = "Paused · not connected";
      } else if (emg) {
        note.textContent = "Emergency mode · 5.8 GHz receiver & sweeps halted";
      } else if (s && !s.rf.enabled) {
        note.textContent = "Off · 5.8 GHz receiver is switched off";
      } else if (wifiOn) {
        note.textContent = `Streaming via Hub Wi-Fi SSE (${this.api.hubBridge.hubHost})`;
      } else if (!this.liveOn) {
        note.textContent = "Paused · click Stream to view live 5.8 GHz readings";
      } else if (l) {
        note.textContent = `Streaming · 10 Hz · sweep ${(l.us / 1000).toFixed(2)} ms`;
      } else {
        note.textContent = "Streaming · waiting for sweeps…";
      }
    }

    const now = performance.now();
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    this.el.querySelectorAll<HTMLElement>("[data-bar]").forEach((row, i) => {
      const onCh = Boolean(this.signalEnabledCh[i]);
      const col = CHANNEL_COLORS[i];
      row.classList.toggle("is-muted", !onCh);
      row.setAttribute("aria-pressed", String(onCh));
      const dot = row.querySelector<HTMLElement>("[data-bar-dot]");
      if (dot) {
        dot.style.background = onCh ? col : "transparent";
        dot.style.boxShadow = onCh ? "none" : `inset 0 0 0 1.5px ${col}`;
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
        const rising = sampleDbm >= this.barFillVal[i];
        if (rising || now - this.barFillAt[i] >= 160) {
          this.barFillVal[i] = sampleDbm;
          if (rising) {
            this.barFillAt[i] = now;
          }
        }
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
}
