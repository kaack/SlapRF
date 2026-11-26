import { Component } from "../core/component";
import { scanCustomSelects } from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  ANDROID_APK_URL,
  IOS_IPA_URL,
  IOS_SIDELOADLY_URL,
  PORTABLE_RELEASES_URL,
  capabilitiesSnapshot,
  orderedPortableAssets,
  subscribeCapabilities,
} from "../services/capabilities";
import { usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";

type BridgeSnapshot = NonNullable<Awaited<ReturnType<ApiClient["fetchPoeBridgeStatus"]>>["bridge"]>;

const BAUD_OPTIONS = [
  { value: 9600, label: "9,600" },
  { value: 19200, label: "19,200" },
  { value: 38400, label: "38,400" },
  { value: 57600, label: "57,600" },
  { value: 115200, label: "115,200 (Default)" },
  { value: 230400, label: "230,400" },
  { value: 460800, label: "460,800" },
  { value: 921600, label: "921,600" },
  { value: 1000000, label: "1,000,000" },
  { value: 2000000, label: "2,000,000" },
];

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(upMs: number): string {
  if (!Number.isFinite(upMs) || upMs <= 0) return "0s";
  const totalSec = Math.floor(upMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function describeUsbVidPid(connected: boolean, vid: string, pid: string): string {
  if (!connected) return "No USB device attached";
  const v = (vid || "").toUpperCase();
  const p = (pid || "").toUpperCase();
  if (v === "303A" && p === "1001") return "Espressif XIAO ESP32-C5 (303A:1001)";
  if (v === "303A") return `Espressif USB Serial (${v}:${p || "0000"})`;
  if (v === "1A86") return `QinHeng CH34x Serial (${v}:${p || "0000"})`;
  if (v === "10C4") return `Silicon Labs CP210x (${v}:${p || "0000"})`;
  if (v === "0403") return `FTDI USB UART (${v}:${p || "0000"})`;
  if (v && v !== "0000") return `USB Serial Device (${v}:${p || "0000"})`;
  return "USB Serial Device";
}

/**
 * PoE Bridge management view (`#/poe`), surfaced in the main navigation whenever
 * `SlapRF (Network)` (`slaprf_net`) is selected.
 */
export class PoeBridgeView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private viewActive = true;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private busyAction: string | null = null;
  private rebootingUntilMs = 0;

  private selectedTarget = "";
  private activeTarget = "";
  private bridge: BridgeSnapshot | null = null;
  private statusError = "";
  private feedbackTone: "good" | "bad" | null = null;
  private feedbackMsg = "";

  // Editable form state (kept stable while user edits)
  private hydratedTargetKey = "";
  private formDhcp = true;
  private formIp = "";
  private formNetmask = "255.255.255.0";
  private formGateway = "";
  private formBaud = 115200;
  private formDirtyNet = false;
  private formDirtyBaud = false;

  private shellBuilt = false;
  private lastStatusSig = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;

      const copyBtn = target.closest<HTMLButtonElement>("button[data-copy]");
      if (copyBtn) {
        const text = copyBtn.dataset.copy ?? "";
        void navigator.clipboard?.writeText(text);
        const iconEl = copyBtn.querySelector<HTMLElement>("[data-copy-icon]");
        copyBtn.classList.add("is-copied");
        if (iconEl) iconEl.innerHTML = icons.check(13);
        window.setTimeout(() => {
          copyBtn.classList.remove("is-copied");
          if (iconEl) iconEl.innerHTML = icons.copy(13);
        }, 1400);
        return;
      }

      const netModeBtn = target.closest<HTMLButtonElement>("button[data-net-mode]");
      if (netModeBtn && !this.busyAction) {
        const nextDhcp = netModeBtn.dataset.netMode === "dhcp";
        if (nextDhcp !== this.formDhcp) {
          this.formDhcp = nextDhcp;
          if (!nextDhcp && this.bridge) {
            if (!this.formIp) this.formIp = this.bridge.staticIp || this.bridge.ip || "";
            if (!this.formNetmask) this.formNetmask = this.bridge.staticNetmask || this.bridge.netmask || "255.255.255.0";
            if (!this.formGateway) this.formGateway = this.bridge.staticGateway || this.bridge.gateway || "";
          }
          this.formDirtyNet = true;
          this.renderNetConfigSection();
        }
        return;
      }

      const refreshBtn = target.closest<HTMLButtonElement>("button[data-action='refresh-bridge']");
      if (refreshBtn && !this.busyAction) {
        this.clearFeedback();
        void this.refreshBridge();
        return;
      }

      const saveNetBtn = target.closest<HTMLButtonElement>("button[data-action='save-netcfg']");
      if (saveNetBtn && !this.busyAction) {
        void this.applyNetConfig();
        return;
      }

      const saveBaudBtn = target.closest<HTMLButtonElement>("button[data-action='save-baud']");
      if (saveBaudBtn && !this.busyAction) {
        void this.applyBaud();
        return;
      }

      const resetUsbBtn = target.closest<HTMLButtonElement>("button[data-action='reset-usb']");
      if (resetUsbBtn && !this.busyAction) {
        void this.runQuickAction("reset-usb");
        return;
      }

      const rebootBtn = target.closest<HTMLButtonElement>("button[data-action='reboot-bridge']");
      if (rebootBtn && !this.busyAction) {
        void this.rebootBridge();
      }
    });

    this.listen(el, "change", (e) => {
      const t = e.target as HTMLElement;
      if (t.matches("select[data-field='bridge-baud']")) {
        const parsed = Number((t as HTMLSelectElement).value);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.formBaud = parsed;
          this.formDirtyBaud = true;
        }
      }
    });

    this.listen(el, "input", (e) => {
      const t = e.target as HTMLElement;
      if (t.matches("input[data-field='net-ip']")) {
        this.formIp = (t as HTMLInputElement).value;
        this.formDirtyNet = true;
      } else if (t.matches("input[data-field='net-mask']")) {
        this.formNetmask = (t as HTMLInputElement).value;
        this.formDirtyNet = true;
      } else if (t.matches("input[data-field='net-gw']")) {
        this.formGateway = (t as HTMLInputElement).value;
        this.formDirtyNet = true;
      }
    });

    this.onDispose(
      store.subscribe(["status", "config"], () => {
        if (!this.viewActive) return;
        this.renderShellIfNeeded();
      })
    );
    this.onDispose(
      usbPool.onChange(() => {
        if (!usbPool.mainConsole.connected && !usbPool.mainConsole.reconnecting && this.rebootingUntilMs === 0) {
          this.selectedTarget = "";
          this.activeTarget = "";
          this.bridge = null;
          this.hydratedTargetKey = "";
          this.formDirtyNet = false;
          this.formDirtyBaud = false;
          if (this.viewActive) {
            this.renderDynamicSlots();
            this.renderAllControlSections();
          }
          return;
        }
        if (this.viewActive) {
          void this.refreshBridge();
        }
      })
    );
    this.onDispose(
      subscribeCapabilities(() => {
        if (!this.viewActive) return;
        this.shellBuilt = false;
        this.renderShellIfNeeded();
        void this.refreshBridge();
      })
    );
    this.onDispose(() => this.stopPolling());

    this.renderShellIfNeeded();
    this.startPolling();
    void this.refreshBridge();
  }

  override onActivate(): void {
    this.viewActive = true;
    this.renderShellIfNeeded();
    this.startPolling();
    void this.refreshBridge();
  }

  override onDeactivate(): void {
    this.viewActive = false;
    this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (!this.viewActive || this.inFlight || this.busyAction) return;
      void this.refreshBridge();
    }, 2500);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearFeedback(): void {
    this.feedbackTone = null;
    this.feedbackMsg = "";
  }

  private setFeedback(tone: "good" | "bad", msg: string): void {
    this.feedbackTone = tone;
    this.feedbackMsg = msg;
    this.renderFeedbackSlot();
  }

  private canReachBridgeBackend(): boolean {
    const caps = capabilitiesSnapshot();
    return Boolean(caps.portable || this.store.simulatorRunning);
  }

  private async refreshBridge(): Promise<void> {
    if (!this.canReachBridgeBackend() || this.inFlight) return;
    if (!usbPool.mainConsole.connected && !usbPool.mainConsole.reconnecting && Date.now() >= this.rebootingUntilMs) {
      this.bridge = null;
      this.statusError = "Not connected to a PoE Bridge.";
      if (this.viewActive) {
        this.renderDynamicSlots();
      }
      return;
    }
    this.inFlight = true;
    try {
      const res = await this.api.fetchPoeBridgeStatus({
        target: this.selectedTarget || undefined,
        scan: false,
      });
      this.activeTarget = res.activeTarget || "";
      if (res.activeTarget) {
        this.selectedTarget = res.activeTarget;
      } else if (!this.selectedTarget && res.target) {
        this.selectedTarget = res.target;
      }
      const hadBridge = Boolean(this.bridge);
      if (res.bridge) {
        this.bridge = res.bridge;
        this.statusError = "";
        if (this.rebootingUntilMs > 0) {
          this.rebootingUntilMs = 0;
          this.setFeedback("good", `PoE Bridge (${res.bridge.endpoint}) is back online.`);
        }
        this.hydrateFormsFromBridge(res.bridge, !hadBridge);
      } else {
        this.bridge = null;
        if (hadBridge) {
          this.renderAllControlSections();
        }
        if (Date.now() < this.rebootingUntilMs) {
          this.statusError = "Waiting for PoE Bridge to finish rebooting…";
        } else {
          this.statusError = res.error || "No PoE Bridge detected on the local network.";
        }
      }
    } catch (err) {
      if (Date.now() < this.rebootingUntilMs) {
        this.statusError = "Waiting for PoE Bridge to finish rebooting…";
      } else {
        this.statusError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.inFlight = false;
      if (this.viewActive) {
        this.renderDynamicSlots();
      }
    }
  }

  private hydrateFormsFromBridge(b: BridgeSnapshot, forceSections = false): void {
    const firstForTarget = this.hydratedTargetKey !== b.endpoint;
    if (firstForTarget || !this.formDirtyNet) {
      this.formDhcp = b.dhcp;
      this.formIp = (b.dhcp ? b.staticIp || b.ip : b.ip) || "";
      this.formNetmask = (b.dhcp ? b.staticNetmask || b.netmask : b.netmask) || "255.255.255.0";
      this.formGateway = (b.dhcp ? b.staticGateway || b.gateway : b.gateway) || "";
    }
    if (firstForTarget || !this.formDirtyBaud) {
      this.formBaud = b.baud > 0 ? b.baud : 115200;
    }
    if (firstForTarget || forceSections) {
      this.hydratedTargetKey = b.endpoint;
      this.renderAllControlSections();
    }
  }

  private renderAllControlSections(): void {
    this.renderNetConfigSection();
    this.renderSerialSection();
    this.renderMaintenanceSection();
  }

  private async applyNetConfig(): Promise<void> {
    this.busyAction = "netcfg";
    this.clearFeedback();
    this.renderAllControlSections();
    try {
      const res = await this.api.sendPoeBridgeAction({
        target: this.selectedTarget || undefined,
        action: "netcfg",
        dhcp: this.formDhcp,
        ip: this.formDhcp ? undefined : this.formIp.trim(),
        netmask: this.formDhcp ? undefined : this.formNetmask.trim(),
        gateway: this.formDhcp ? undefined : this.formGateway.trim(),
      });
      this.formDirtyNet = false;
      if (res.target) {
        this.selectedTarget = res.target;
      }
      if (res.bridge) {
        this.bridge = res.bridge;
        this.hydratedTargetKey = "";
        this.hydrateFormsFromBridge(res.bridge);
      }
      this.setFeedback("good", res.message || "Network configuration saved.");
    } catch (err) {
      this.setFeedback("bad", err instanceof Error ? err.message : String(err));
    } finally {
      this.busyAction = null;
      this.renderDynamicSlots();
      this.renderAllControlSections();
    }
  }

  private async applyBaud(): Promise<void> {
    this.busyAction = "baud";
    this.clearFeedback();
    this.renderAllControlSections();
    try {
      const res = await this.api.sendPoeBridgeAction({
        target: this.selectedTarget || undefined,
        action: "baud",
        baud: this.formBaud,
      });
      this.formDirtyBaud = false;
      if (res.bridge) {
        this.bridge = res.bridge;
      }
      this.setFeedback("good", res.message || `Baud rate set to ${this.formBaud.toLocaleString()}.`);
    } catch (err) {
      this.setFeedback("bad", err instanceof Error ? err.message : String(err));
    } finally {
      this.busyAction = null;
      this.renderDynamicSlots();
      this.renderAllControlSections();
    }
  }

  private async runQuickAction(action: "reset-usb"): Promise<void> {
    this.busyAction = action;
    this.clearFeedback();
    this.renderAllControlSections();
    try {
      const res = await this.api.sendPoeBridgeAction({
        target: this.selectedTarget || undefined,
        action,
      });
      if (res.bridge) {
        this.bridge = res.bridge;
      }
      this.setFeedback("good", res.message || "USB-A device restarted.");
    } catch (err) {
      this.setFeedback("bad", err instanceof Error ? err.message : String(err));
    } finally {
      this.busyAction = null;
      this.renderDynamicSlots();
      this.renderAllControlSections();
    }
  }

  private async rebootBridge(): Promise<void> {
    this.busyAction = "reboot";
    this.clearFeedback();
    this.renderAllControlSections();
    try {
      const res = await this.api.sendPoeBridgeAction({
        target: this.selectedTarget || undefined,
        action: "reboot",
      });
      if (this.store.simulatorRunning && res.bridge) {
        this.bridge = res.bridge;
        this.setFeedback("good", res.message || "PoE Bridge rebooted.");
      } else {
        this.rebootingUntilMs = Date.now() + 9000;
        this.bridge = null;
        this.statusError = "Rebooting PoE Bridge… Waiting for Ethernet link to return.";
        this.setFeedback("good", res.message || "Rebooting PoE Bridge…");
      }
    } catch (err) {
      this.setFeedback("bad", err instanceof Error ? err.message : String(err));
    } finally {
      this.busyAction = null;
      this.renderDynamicSlots();
      this.renderAllControlSections();
    }
  }

  private renderShellIfNeeded(): void {
    const canReach = this.canReachBridgeBackend();
    const shellModeKey = canReach ? "live" : "demo-gate";
    if (this.shellBuilt && this.el.dataset.poeShellMode === shellModeKey) {
      return;
    }
    this.shellBuilt = true;
    this.el.dataset.poeShellMode = shellModeKey;
    this.lastStatusSig = "";

    if (!canReach) {
      const downloads = orderedPortableAssets()
        .map(
          (a) =>
            `<a class="btn btn-sm ${a.recommended ? "" : "btn-ghost"}" href="${PORTABLE_RELEASES_URL}/download/${a.file}" download title="${a.file}">${esc(a.label)}</a>`
        )
        .join("");

      this.el.innerHTML = `
        <div class="settings debug-page">
          <section class="settings-section" data-section-anchor="portable">
            <div class="settings-intro">
              <h2>SlapRF Server required for LAN hardware</h2>
              <p>Browser tabs cannot open raw UDP or TCP sockets to a physical PoE Bridge directly. Run SlapRF Portable or the native Android / iOS app on your network, or enable Simulation active to preview PoE Bridge controls.</p>
            </div>
            <div class="card">
              <div class="option-row">
                <div>
                  <div class="option-title">Download SlapRF</div>
                  <div class="option-sub">Standalone desktop server or mobile app with built-in PoE Ethernet discovery, TCP :5480 low-latency streaming, and live bridge management.</div>
                  <div class="laprf-emulator-downloads" style="margin-top:12px;">
                    ${downloads}
                    <a class="btn btn-sm btn-ghost" href="${ANDROID_APK_URL}" download title="slaprf-android-arm64.apk">Android APK</a>
                    <a class="btn btn-sm btn-ghost" href="${IOS_SIDELOADLY_URL}" title="Install slaprf-ios-arm64.ipa via Sideloadly">iOS (Sideloadly)</a>
                    <a class="btn btn-sm btn-ghost" href="${IOS_IPA_URL}" download title="slaprf-ios-arm64.ipa">iOS (.ipa)</a>
                    <a class="link-inline" href="${PORTABLE_RELEASES_URL}" target="_blank" rel="noopener">All releases</a>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>`;
      return;
    }

    this.el.innerHTML = `
      <div class="settings debug-page poe-bridge-page">
        <div data-slot="poe-feedback"></div>

        <section class="settings-section" data-section-anchor="status">
          <div class="settings-intro">
            <h2>Bridge status</h2>
            <p>Live Ethernet link, IPv4 lease, attached USB-A device, and stream counters from your Waveshare ESP32-P4-WIFI6-POE-ETH.</p>
          </div>
          <div class="debug-status-layout" data-slot="poe-status"></div>
        </section>

        <section class="settings-section" data-section-anchor="network">
          <div class="settings-intro">
            <h2>IPv4 settings</h2>
            <p>Use automatic DHCP (with link-local fallback on a direct laptop PoE cable) or assign a fixed static IPv4 address.</p>
          </div>
          <div class="settings-cards" data-slot="poe-netcfg"></div>
        </section>

        <section class="settings-section" data-section-anchor="serial">
          <div class="settings-intro">
            <h2>USB-A serial</h2>
            <p>Configure serial baud rate for UART-bridged USB timers, or restart the attached USB-A device remotely over Ethernet.</p>
          </div>
          <div class="settings-cards" data-slot="poe-serial"></div>
        </section>

        <section class="settings-section" data-section-anchor="maintenance">
          <div class="settings-intro">
            <h2>Maintenance</h2>
            <p>Restart the PoE Bridge remotely over Ethernet.</p>
          </div>
          <div class="settings-cards" data-slot="poe-maintenance"></div>
        </section>
      </div>`;

    this.renderDynamicSlots();
    this.renderAllControlSections();
  }

  private renderFeedbackSlot(): void {
    const slot = this.el.querySelector<HTMLElement>("[data-slot='poe-feedback']");
    if (!slot) return;
    if (!this.feedbackMsg || !this.feedbackTone) {
      slot.innerHTML = "";
      return;
    }
    const cls = this.feedbackTone === "good" ? "badge-good" : "badge-bad";
    slot.innerHTML = `
      <div class="card" style="padding:10px 14px;margin-bottom:4px;display:flex;align-items:center;gap:10px;">
        <span class="badge ${cls}">${this.feedbackTone === "good" ? "Updated" : "Error"}</span>
        <span>${esc(this.feedbackMsg)}</span>
      </div>`;
  }

  private renderDynamicSlots(): void {
    this.renderFeedbackSlot();
    const statusSlot = this.el.querySelector<HTMLElement>("[data-slot='poe-status']");
    if (!statusSlot) return;

    const b = this.bridge;
    const isRebooting = Date.now() < this.rebootingUntilMs;
    const ledCls = b
      ? b.linkUp && b.usbConnected
        ? "is-up"
        : b.linkUp
          ? "is-warn"
          : "is-bad"
      : isRebooting
        ? "is-warn"
        : "is-bad";

    const headline = b
      ? `${esc(b.board)} (${esc(b.endpoint)}) · ${b.linkUp ? `${b.linkSpeedMbps || 100} Mbps ${b.fullDuplex ? "Full-Duplex" : "Half-Duplex"}` : "Link down"}`
      : esc(this.statusError || "Reading connected PoE Bridge…");

    const sig = JSON.stringify({
      b,
      err: this.statusError,
      sel: this.selectedTarget,
      act: this.activeTarget,
      busy: this.busyAction,
      reb: isRebooting,
    });
    if (sig === this.lastStatusSig) {
      return;
    }
    this.lastStatusSig = sig;

    const ethBadge = b
      ? b.linkUp
        ? `<span class="badge badge-good">${b.linkSpeedMbps || 100} Mbps ${b.fullDuplex ? "FDX" : "HDX"}</span>`
        : `<span class="badge badge-bad">Link down</span>`
      : `<span class="badge">${isRebooting ? "Rebooting" : "Offline"}</span>`;

    const usbBadge = b
      ? b.usbConnected
        ? `<span class="badge badge-good">Attached</span>`
        : `<span class="badge badge-warn">Unplugged</span>`
      : `<span class="badge">Unknown</span>`;

    statusSlot.innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledCls}"></span>
          <span class="debug-head-note">${headline}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="refresh-bridge" title="Refresh status now">
            ${icons.reset(14)}<span>Refresh</span>
          </button>
        </div>
      </div>

      <div class="debug-timer-detail-grid">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${b?.linkUp ? "is-active" : ""}">${icons.plug(14)}<span>Ethernet & PoE</span></span>
            ${ethBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>IPv4 endpoint</dt>
              <dd>${
                b
                  ? `<button type="button" class="laprf-emulator-copy-pill" data-copy="${esc(b.endpoint)}" title="Copy ${esc(b.endpoint)}" style="padding:2px 8px;">
                      <span class="mono">${esc(b.endpoint)}</span>
                      <span class="laprf-emulator-copy-icon" data-copy-icon>${icons.copy(12)}</span>
                    </button>`
                  : "Not connected"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Addressing</dt>
              <dd>${
                b
                  ? `${b.dhcp ? `<span class="badge">DHCP</span>` : `<span class="badge badge-warn">Static IP</span>`} <span class="note mono">${esc(b.netmask || "255.255.255.0")}${b.gateway && b.gateway !== "0.0.0.0" ? ` · gw ${esc(b.gateway)}` : ""}</span>`
                  : "Not available"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>MAC address</dt>
              <dd class="mono">${b?.mac ? esc(b.mac) : "Not available"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware & uptime</dt>
              <dd>${b ? `<span class="mono">v${esc(b.bridgeFw || "0.1.0")}</span> <span class="note">· up ${esc(formatUptime(b.upMs))}</span>` : "Not available"}</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${b?.usbConnected ? "is-active" : ""}">${icons.cpu(14)}<span>USB-A Host & TCP stream</span></span>
            ${usbBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>USB-A device</dt>
              <dd>${b ? esc(describeUsbVidPid(b.usbConnected, b.usbVid, b.usbPid)) : "Not available"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Baud rate</dt>
              <dd>${b ? `<span class="mono">${b.baud.toLocaleString()} 8N1</span>` : "Not available"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>TCP :5480 serial</dt>
              <dd>${
                b
                  ? b.tcpConnected
                    ? `<span class="badge badge-good">In use (1/1)</span> <span class="mono note">${esc(b.tcpPeer || "connected")}</span>`
                    : `<span class="badge">Available (0/1)</span>`
                  : "Not available"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Serial traffic</dt>
              <dd>${b ? `<span class="mono">${esc(formatBytes(b.rxBytes))}</span> RX · <span class="mono">${esc(formatBytes(b.txBytes))}</span> TX` : "0 B"}</dd>
            </div>
          </dl>
        </div>
      </div>`;
    scanCustomSelects(statusSlot);
  }

  private renderNetConfigSection(): void {
    const slot = this.el.querySelector<HTMLElement>("[data-slot='poe-netcfg']");
    if (!slot) return;
    const b = this.bridge;
    const saving = this.busyAction === "netcfg";
    const fieldsReadOnly = this.formDhcp || saving || !b;

    const shownIp = this.formDhcp ? b?.ip || this.formIp : this.formIp;
    const shownMask = this.formDhcp ? b?.netmask || this.formNetmask || "255.255.255.0" : this.formNetmask;
    const shownGw = this.formDhcp ? b?.gateway || this.formGateway : this.formGateway;

    slot.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">IPv4 mode</div>
            <div class="option-sub">Automatic acquires an IP via DHCP (or 169.254.x.x link-local on a direct cable). Static uses the fixed IPv4 below.</div>
          </div>
          <div class="option-actions diag-log-actions">
            <div class="segmented" role="radiogroup" aria-label="IPv4 addressing mode">
              <button
                type="button"
                role="radio"
                aria-checked="${this.formDhcp}"
                class="${this.formDhcp ? "is-active" : ""}"
                data-net-mode="dhcp"
                ${saving ? "disabled" : ""}
              >Automatic (DHCP)</button>
              <button
                type="button"
                role="radio"
                aria-checked="${!this.formDhcp}"
                class="${!this.formDhcp ? "is-active" : ""}"
                data-net-mode="static"
                ${saving ? "disabled" : ""}
              >Static IPv4</button>
            </div>
          </div>
        </div>

        <div class="datasource-server-panel">
          <div class="poe-netcfg-fields">
            <label class="poe-netcfg-field">
              <span class="poe-netcfg-label">IPv4 address</span>
              <input
                type="text"
                class="input mono"
                data-field="net-ip"
                value="${esc(shownIp)}"
                placeholder="192.168.1.110"
                aria-label="IPv4 address"
                ${fieldsReadOnly ? "disabled" : ""}
              />
            </label>
            <label class="poe-netcfg-field">
              <span class="poe-netcfg-label">Subnet mask</span>
              <input
                type="text"
                class="input mono"
                data-field="net-mask"
                value="${esc(shownMask)}"
                placeholder="255.255.255.0"
                aria-label="Subnet mask"
                ${fieldsReadOnly ? "disabled" : ""}
              />
            </label>
            <label class="poe-netcfg-field">
              <span class="poe-netcfg-label">Default gateway</span>
              <input
                type="text"
                class="input mono"
                data-field="net-gw"
                value="${esc(shownGw)}"
                placeholder="192.168.1.1"
                aria-label="Default gateway"
                ${fieldsReadOnly ? "disabled" : ""}
              />
            </label>
          </div>
          <div class="poe-netcfg-foot">
            <button type="button" class="btn btn-sm" data-action="save-netcfg" ${saving || !b ? "disabled" : ""}>
              ${icons.check(14)}<span>${saving ? "Applying…" : "Apply"}</span>
            </button>
          </div>
        </div>
      </div>`;
  }

  private renderSerialSection(): void {
    const slot = this.el.querySelector<HTMLElement>("[data-slot='poe-serial']");
    if (!slot) return;
    const b = this.bridge;
    const busy = Boolean(this.busyAction);
    const hasCustomBaud = !BAUD_OPTIONS.some((o) => o.value === this.formBaud);

    slot.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Baud rate</div>
            <div class="option-sub">Serial speed for UART-bridged USB timers. XIAO ESP32-C5 USB-Serial/JTAG runs at full USB speed regardless of baud rate.</div>
          </div>
          <div class="option-actions diag-log-actions poe-baud-actions">
            <select class="input input-sm mono poe-baud-select" data-field="bridge-baud" aria-label="USB-A baud rate" ${busy || !b ? "disabled" : ""}>
              ${hasCustomBaud ? `<option value="${this.formBaud}" selected>${this.formBaud.toLocaleString()}</option>` : ""}
              ${BAUD_OPTIONS.map(
                (opt) => `<option value="${opt.value}" ${opt.value === this.formBaud ? "selected" : ""}>${esc(opt.label)}</option>`
              ).join("")}
            </select>
            <button type="button" class="btn btn-sm" data-action="save-baud" ${busy || !b ? "disabled" : ""}>
              <span>${this.busyAction === "baud" ? "Applying…" : "Apply"}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Restart USB-A timer</div>
            <div class="option-sub">Remotely restarts Hub H1 or any timer plugged into the USB-A port without walking out to the gate.</div>
          </div>
          <div class="option-actions diag-log-actions">
            <button type="button" class="btn btn-sm" data-action="reset-usb" ${busy || !b || !b.usbConnected ? "disabled" : ""}>
              ${icons.reset(14)}<span>${this.busyAction === "reset-usb" ? "Restarting…" : "Restart USB Device"}</span>
            </button>
          </div>
        </div>
      </div>`;
    scanCustomSelects(slot);
  }

  private renderMaintenanceSection(): void {
    const slot = this.el.querySelector<HTMLElement>("[data-slot='poe-maintenance']");
    if (!slot) return;
    const b = this.bridge;
    const busy = Boolean(this.busyAction);

    slot.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Reboot PoE Bridge</div>
            <div class="option-sub">Restarts the Waveshare ESP32-P4 over Ethernet. PoE link and Hub H1 stream return in about 3 seconds.</div>
          </div>
          <div class="option-actions diag-log-actions">
            <button type="button" class="btn btn-sm" data-action="reboot-bridge" ${busy || !b ? "disabled" : ""}>
              ${icons.power(14)}<span>${this.busyAction === "reboot" ? "Rebooting…" : "Reboot Bridge"}</span>
            </button>
          </div>
        </div>
      </div>`;
  }
}
