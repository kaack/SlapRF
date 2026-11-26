import { Component } from "../core/component";
import { scanCustomSelects } from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { pushAppHash } from "../core/router";
import { ApiClient } from "../services/api_client";
import {
  PORTABLE_RELEASES_URL,
  capabilitiesSnapshot,
  orderedPortableAssets,
  subscribeCapabilities,
} from "../services/capabilities";
import { AppStore } from "../state/store";

type BridgeSnapshot = NonNullable<Awaited<ReturnType<ApiClient["fetchPoeBridgeStatus"]>>["bridge"]>;
type DiscoveredBridge = Awaited<ReturnType<ApiClient["fetchPoeBridgeStatus"]>>["devices"][number];

const BAUD_OPTIONS = [
  { value: 9600, label: "9,600 baud" },
  { value: 19200, label: "19,200 baud" },
  { value: 38400, label: "38,400 baud" },
  { value: 57600, label: "57,600 baud" },
  { value: 115200, label: "115,200 baud (Default)" },
  { value: 230400, label: "230,400 baud" },
  { value: 460800, label: "460,800 baud" },
  { value: 921600, label: "921,600 baud" },
  { value: 1000000, label: "1,000,000 baud" },
  { value: 2000000, label: "2,000,000 baud" },
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
  private subnet = "";
  private bridge: BridgeSnapshot | null = null;
  private devices: DiscoveredBridge[] = [];
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
          this.formDirtyNet = true;
          this.renderNetConfigSection();
        }
        return;
      }

      const openFlasherBtn = target.closest<HTMLButtonElement>("button[data-action='open-flasher']");
      if (openFlasherBtn) {
        pushAppHash("#/flasher");
        return;
      }

      const scanBtn = target.closest<HTMLButtonElement>("button[data-action='scan-bridges']");
      if (scanBtn && !this.busyAction) {
        this.clearFeedback();
        void this.refreshBridge(true);
        return;
      }

      const refreshBtn = target.closest<HTMLButtonElement>("button[data-action='refresh-bridge']");
      if (refreshBtn && !this.busyAction) {
        this.clearFeedback();
        void this.refreshBridge(false);
        return;
      }

      const applyTargetBtn = target.closest<HTMLButtonElement>("button[data-action='select-target']");
      if (applyTargetBtn && !this.busyAction) {
        const input = this.el.querySelector<HTMLInputElement>("input[data-field='manual-target']");
        if (input && input.value.trim()) {
          this.selectedTarget = input.value.trim();
          this.hydratedTargetKey = "";
          this.formDirtyNet = false;
          this.formDirtyBaud = false;
          this.clearFeedback();
          void this.refreshBridge(false);
        }
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

      const resetCountersBtn = target.closest<HTMLButtonElement>("button[data-action='reset-counters']");
      if (resetCountersBtn && !this.busyAction) {
        void this.runQuickAction("reset-counters");
        return;
      }

      const rebootBtn = target.closest<HTMLButtonElement>("button[data-action='reboot-bridge']");
      if (rebootBtn && !this.busyAction) {
        void this.rebootBridge();
      }
    });

    this.listen(el, "change", (e) => {
      const t = e.target as HTMLElement;
      if (t.matches("select[data-field='bridge-picker']")) {
        const val = (t as HTMLSelectElement).value.trim();
        if (val && val !== this.selectedTarget) {
          this.selectedTarget = val;
          this.hydratedTargetKey = "";
          this.formDirtyNet = false;
          this.formDirtyBaud = false;
          this.clearFeedback();
          void this.refreshBridge(false);
        }
        return;
      }
      if (t.matches("select[data-field='bridge-baud']")) {
        const parsed = Number((t as HTMLSelectElement).value);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.formBaud = parsed;
          this.formDirtyBaud = true;
        }
        return;
      }
      if (t.matches("input[data-action='toggle-dtr']")) {
        const checked = (t as HTMLInputElement).checked;
        void this.toggleControlLine("dtr", checked);
        return;
      }
      if (t.matches("input[data-action='toggle-rts']")) {
        const checked = (t as HTMLInputElement).checked;
        void this.toggleControlLine("rts", checked);
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

    this.listen(el, "keydown", (e) => {
      if (e.key === "Enter") {
        const t = e.target as HTMLElement;
        if (t.matches("input[data-field='manual-target']")) {
          e.preventDefault();
          const val = (t as HTMLInputElement).value.trim();
          if (val && !this.busyAction) {
            this.selectedTarget = val;
            this.hydratedTargetKey = "";
            this.clearFeedback();
            void this.refreshBridge(false);
          }
        }
      }
    });

    this.onDispose(
      store.subscribe(["status", "config"], () => {
        if (!this.viewActive) return;
        this.renderShellIfNeeded();
      })
    );
    this.onDispose(
      subscribeCapabilities(() => {
        if (!this.viewActive) return;
        this.shellBuilt = false;
        this.renderShellIfNeeded();
        void this.refreshBridge(true);
      })
    );
    this.onDispose(() => this.stopPolling());

    this.renderShellIfNeeded();
    this.startPolling();
    void this.refreshBridge(true);
  }

  override onActivate(): void {
    this.viewActive = true;
    this.renderShellIfNeeded();
    this.startPolling();
    void this.refreshBridge(false);
  }

  override onDeactivate(): void {
    this.viewActive = false;
    this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (!this.viewActive || this.inFlight || this.busyAction) return;
      void this.refreshBridge(false);
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

  private async refreshBridge(scanLan: boolean): Promise<void> {
    if (!this.canReachBridgeBackend() || this.inFlight) return;
    this.inFlight = true;
    try {
      const res = await this.api.fetchPoeBridgeStatus({
        target: this.selectedTarget || undefined,
        scan: scanLan,
      });
      this.activeTarget = res.activeTarget || "";
      if (scanLan || this.devices.length === 0) {
        this.devices = res.devices ?? [];
        if (res.subnet) this.subnet = res.subnet;
      }
      if (!this.selectedTarget && res.target) {
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
          this.renderNetConfigSection();
          this.renderSerialSection();
          this.renderMaintenanceSection();
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
      this.renderNetConfigSection();
      this.renderSerialSection();
      this.renderMaintenanceSection();
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
      this.setFeedback("good", res.message || `USB-A baud rate set to ${this.formBaud.toLocaleString()}.`);
    } catch (err) {
      this.setFeedback("bad", err instanceof Error ? err.message : String(err));
    } finally {
      this.busyAction = null;
      this.renderDynamicSlots();
      this.renderAllControlSections();
    }
  }

  private async toggleControlLine(line: "dtr" | "rts", value: boolean): Promise<void> {
    this.busyAction = "lines";
    this.clearFeedback();
    try {
      const res = await this.api.sendPoeBridgeAction({
        target: this.selectedTarget || undefined,
        action: "lines",
        ...(line === "dtr" ? { dtr: value } : { rts: value }),
      });
      if (res.bridge) {
        this.bridge = res.bridge;
      }
      this.setFeedback("good", `${line.toUpperCase()} line ${value ? "enabled" : "disabled"}.`);
    } catch (err) {
      this.setFeedback("bad", err instanceof Error ? err.message : String(err));
    } finally {
      this.busyAction = null;
      this.renderDynamicSlots();
      this.renderAllControlSections();
    }
  }

  private async runQuickAction(action: "reset-usb" | "reset-counters"): Promise<void> {
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
      this.setFeedback("good", res.message || "Command completed.");
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
              <p>Browser tabs cannot send raw UDP or TCP sockets to a physical PoE Bridge directly. Run SlapRF Portable or the SlapRF Android app on your network, or enable Simulation active to preview PoE Bridge controls.</p>
            </div>
            <div class="card">
              <div class="option-row" style="border-bottom:0;">
                <div>
                  <div class="option-title">Download SlapRF Portable</div>
                  <div class="option-sub">Standalone single-file server with built-in PoE Ethernet discovery, TCP :5480 low-latency streaming, and live bridge management.</div>
                  <div class="laprf-emulator-downloads" style="margin-top:12px;">
                    ${downloads}
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
            <h2>IPv4 network settings</h2>
            <p>Keep automatic DHCP (with link-local fallback when plugged straight into a laptop), or assign a fixed static IPv4 address.</p>
          </div>
          <div class="card" data-slot="poe-netcfg"></div>
        </section>

        <section class="settings-section" data-section-anchor="serial">
          <div class="settings-intro">
            <h2>USB-A serial & device controls</h2>
            <p>Configure default USB-A UART baud rate, toggle DTR/RTS control lines, or remotely reset the attached USB-A timer over Ethernet.</p>
          </div>
          <div class="card" data-slot="poe-serial"></div>
        </section>

        <section class="settings-section" data-section-anchor="maintenance">
          <div class="settings-intro">
            <h2>Maintenance</h2>
            <p>Restart the PoE Bridge remotely over Ethernet, or open the USB-C firmware flasher to update bridge firmware.</p>
          </div>
          <div class="card" data-slot="poe-maintenance"></div>
        </section>
      </div>`;

    this.renderDynamicSlots();
    this.renderNetConfigSection();
    this.renderSerialSection();
    this.renderMaintenanceSection();
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
      ? `${esc(b.board)} (${esc(b.endpoint)}) · ${b.linkUp ? `${b.linkSpeedMbps || 100} Mbps ${b.fullDuplex ? "Full-Duplex" : "Half-Duplex"}` : "Link down"}${
          this.activeTarget === b.endpoint ? " · Active timing bridge" : ""
        }`
      : esc(this.statusError || "Scanning local network for PoE Bridges…");

    const knownEndpoints = new Set<string>();
    const options: Array<{ endpoint: string; label: string }> = [];
    if (this.activeTarget) {
      knownEndpoints.add(this.activeTarget);
      options.push({ endpoint: this.activeTarget, label: `${this.activeTarget} (Connected)` });
    }
    for (const d of this.devices) {
      if (!knownEndpoints.has(d.endpoint)) {
        knownEndpoints.add(d.endpoint);
        options.push({
          endpoint: d.endpoint,
          label: `${d.endpoint}${d.mac ? ` · ${d.mac}` : ""}`,
        });
      }
    }
    if (this.selectedTarget && !knownEndpoints.has(this.selectedTarget)) {
      knownEndpoints.add(this.selectedTarget);
      options.push({ endpoint: this.selectedTarget, label: this.selectedTarget });
    }

    const sig = JSON.stringify({
      b,
      err: this.statusError,
      sel: this.selectedTarget,
      act: this.activeTarget,
      opts: options,
      busy: this.busyAction,
      reb: isRebooting,
    });
    const manualFocused = Boolean(
      document.activeElement &&
        statusSlot.contains(document.activeElement) &&
        (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT")
    );
    if (manualFocused || sig === this.lastStatusSig) {
      return;
    }
    this.lastStatusSig = sig;

    const pickerHtml =
      options.length > 0
        ? `<select class="input mono" data-field="bridge-picker" aria-label="Target PoE Bridge" style="min-width:190px;height:32px;padding:0 28px 0 10px;">
            ${options
              .map(
                (o) =>
                  `<option value="${esc(o.endpoint)}" ${o.endpoint === this.selectedTarget ? "selected" : ""}>${esc(o.label)}</option>`
              )
              .join("")}
          </select>`
        : `<input
            type="text"
            class="input mono"
            data-field="manual-target"
            value="${esc(this.selectedTarget)}"
            placeholder="192.168.1.110:5480"
            aria-label="PoE Bridge IP and port"
            style="width:185px;height:32px;"
          />
          <button type="button" class="btn btn-sm" data-action="select-target">Probe</button>`;

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
        <div class="debug-connect-actions" style="flex-wrap:wrap;">
          ${pickerHtml}
          <button type="button" class="btn btn-sm btn-ghost" data-action="scan-bridges" title="Broadcast UDP :5480 discovery on LAN">
            ${icons.wifi(14)}<span>Discover</span>
          </button>
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
              <dd>${b ? esc(describeUsbUsbPort(b)) : "Not available"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>UART line coding</dt>
              <dd>${
                b
                  ? `<span class="mono">${b.baud.toLocaleString()} 8N1</span> <span class="note">· DTR ${b.dtr ? "ON" : "OFF"} · RTS ${b.rts ? "ON" : "OFF"}</span>`
                  : "Not available"
              }</dd>
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
    const saving = this.busyAction === "netcfg";
    const staticDis = this.formDhcp || saving ? "disabled" : "";

    slot.innerHTML = `
      <div class="option-row">
        <div>
          <div class="option-title">IPv4 mode</div>
          <div class="option-sub">Automatic uses DHCP on router networks and falls back to 169.254.x.x on a direct laptop PoE cable.</div>
        </div>
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

      ${
        this.formDhcp
          ? ""
          : `<div class="option-row" style="align-items:flex-end;flex-wrap:wrap;gap:12px;">
              <div style="flex:1 1 170px;">
                <label class="flasher-field-label" style="display:block;margin-bottom:4px;">IPv4 address</label>
                <input
                  type="text"
                  class="input mono"
                  data-field="net-ip"
                  value="${esc(this.formIp)}"
                  placeholder="192.168.1.110"
                  aria-label="Static IPv4 address"
                  ${staticDis}
                />
              </div>
              <div style="flex:1 1 170px;">
                <label class="flasher-field-label" style="display:block;margin-bottom:4px;">Subnet mask</label>
                <input
                  type="text"
                  class="input mono"
                  data-field="net-mask"
                  value="${esc(this.formNetmask)}"
                  placeholder="255.255.255.0"
                  aria-label="Static IPv4 subnet mask"
                  ${staticDis}
                />
              </div>
              <div style="flex:1 1 170px;">
                <label class="flasher-field-label" style="display:block;margin-bottom:4px;">Default gateway</label>
                <input
                  type="text"
                  class="input mono"
                  data-field="net-gw"
                  value="${esc(this.formGateway)}"
                  placeholder="192.168.1.1"
                  aria-label="Static IPv4 default gateway"
                  ${staticDis}
                />
              </div>
            </div>`
      }

      <div class="option-row" style="border-bottom:0;">
        <div>
          <div class="option-title">Save network configuration</div>
          <div class="option-sub">Stores the IPv4 mode in bridge NVS flash and applies it immediately without touching USB-A timing settings.</div>
        </div>
        <button type="button" class="btn" data-action="save-netcfg" ${saving || !this.bridge ? "disabled" : ""}>
          ${icons.check(14)}<span>${saving ? "Applying…" : "Apply Network Settings"}</span>
        </button>
      </div>`;
  }

  private renderSerialSection(): void {
    const slot = this.el.querySelector<HTMLElement>("[data-slot='poe-serial']");
    if (!slot) return;
    const b = this.bridge;
    const busy = Boolean(this.busyAction);
    const hasCustomBaud = !BAUD_OPTIONS.some((o) => o.value === this.formBaud);

    slot.innerHTML = `
      <div class="option-row">
        <div>
          <div class="option-title">USB-A default baud rate</div>
          <div class="option-sub">Applies to UART-bridged USB timers (CH34x, CP210x, FTDI). XIAO ESP32-C5 USB-Serial/JTAG transfers at full USB 2.0 speed regardless of baud rate.</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <select class="input mono" data-field="bridge-baud" aria-label="USB-A baud rate" style="min-width:195px;" ${busy || !b ? "disabled" : ""}>
            ${hasCustomBaud ? `<option value="${this.formBaud}" selected>${this.formBaud.toLocaleString()} baud</option>` : ""}
            ${BAUD_OPTIONS.map(
              (opt) => `<option value="${opt.value}" ${opt.value === this.formBaud ? "selected" : ""}>${esc(opt.label)}</option>`
            ).join("")}
          </select>
          <button type="button" class="btn" data-action="save-baud" ${busy || !b ? "disabled" : ""}>
            <span>${this.busyAction === "baud" ? "Saving…" : "Set Baud"}</span>
          </button>
        </div>
      </div>

      <div class="option-row">
        <div>
          <div class="option-title">USB-A control lines (DTR / RTS)</div>
          <div class="option-sub">Keep DTR enabled and RTS disabled for normal Hub H1 operation.</div>
        </div>
        <div style="display:flex;align-items:center;gap:16px;">
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
            <span class="mono">DTR</span>
            <span class="switch">
              <input type="checkbox" data-action="toggle-dtr" ${b?.dtr !== false ? "checked" : ""} ${busy || !b ? "disabled" : ""} />
              <span></span>
            </span>
          </label>
          <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
            <span class="mono">RTS</span>
            <span class="switch">
              <input type="checkbox" data-action="toggle-rts" ${b?.rts ? "checked" : ""} ${busy || !b ? "disabled" : ""} />
              <span></span>
            </span>
          </label>
        </div>
      </div>

      <div class="option-row" style="border-bottom:0;">
        <div>
          <div class="option-title">Attached USB-A device & counters</div>
          <div class="option-sub">Pulse DTR/RTS to restart Hub H1 at the gate remotely, or clear cumulative RX/TX byte counters.</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-ghost" data-action="reset-counters" ${busy || !b ? "disabled" : ""}>
            <span>Clear Counters</span>
          </button>
          <button type="button" class="btn btn-sm" data-action="reset-usb" ${busy || !b || !b.usbConnected ? "disabled" : ""}>
            ${icons.reset(14)}<span>${this.busyAction === "reset-usb" ? "Resetting USB…" : "Reset USB-A Device"}</span>
          </button>
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
      <div class="option-row">
        <div>
          <div class="option-title">Reboot PoE Bridge</div>
          <div class="option-sub">Restarts the ESP32-P4 over Ethernet. PoE link and Hub H1 stream resume automatically in about 3 seconds.</div>
        </div>
        <button type="button" class="btn" data-action="reboot-bridge" ${busy || !b ? "disabled" : ""}>
          ${icons.power(14)}<span>${this.busyAction === "reboot" ? "Rebooting…" : "Reboot Bridge"}</span>
        </button>
      </div>

      <div class="option-row" style="border-bottom:0;">
        <div>
          <div class="option-title">Update PoE Bridge firmware</div>
          <div class="option-sub">Plug the Waveshare board's USB-C port into this computer and use the Firmware Flasher to write the latest bridge image.</div>
        </div>
        <button type="button" class="btn btn-ghost" data-action="open-flasher">
          ${icons.cpu(14)}<span>Open Flasher</span>
        </button>
      </div>`;
  }
}

function describeUsbUsbPort(b: BridgeSnapshot): string {
  return describeUsbVidPid(b.usbConnected, b.usbVid, b.usbPid);
}
