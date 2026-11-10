import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  LIVETIME_PORT,
  LIVETIME_RELAY_URL,
  LiveTimeRelay,
  sharedLiveTimeRelay,
} from "../services/livetime_relay";
import { gateLabel } from "../state/selectors";
import { AppStore } from "../state/store";

const RELEASES_URL = "https://github.com/kaack/SlapRF/releases/latest";

interface RelayAsset {
  os: "windows" | "macos" | "linux";
  label: string;
  file: string;
}

/** Must match the asset names attached by .github/workflows/release.yml. */
const RELAY_ASSETS: RelayAsset[] = [
  { os: "windows", label: "Windows (x64)", file: "slaprf-relay-windows-amd64.exe" },
  { os: "macos", label: "macOS (Apple silicon)", file: "slaprf-relay-macos-arm64" },
  { os: "macos", label: "macOS (Intel)", file: "slaprf-relay-macos-amd64" },
  { os: "linux", label: "Linux (x64)", file: "slaprf-relay-linux-amd64" },
  { os: "linux", label: "Linux (ARM64)", file: "slaprf-relay-linux-arm64" },
];

function detectOs(): RelayAsset["os"] | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "macos";
  if (p.includes("linux") && !p.includes("android")) return "linux";
  return null;
}

/** LiveTime page: two-column layout with live relay/LiveTime status, relay helper downloads, and LiveTime setup. */
export class LiveTimeView extends Component {
  private readonly store: AppStore;
  private readonly relay: LiveTimeRelay;

  constructor(el: HTMLElement, store: AppStore, relay: LiveTimeRelay = sharedLiveTimeRelay) {
    super(el);
    this.store = store;
    this.relay = relay;

    el.innerHTML = `
      <div class="settings debug-page">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Status</h2>
            <p>Live link status between this browser, the local <code>slaprf-relay</code> helper, and MultiGP LiveTime.</p>
          </div>
          <div class="debug-status-layout" data-slot="status"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Relay helper</h2>
            <p>Browsers cannot accept raw TCP connections directly. Run <code>slaprf-relay</code> on this computer to bridge LiveTime TCP port <code>${LIVETIME_PORT}</code> to this tab.</p>
          </div>
          <div class="card">
            <div class="livetime">
              <ol class="steps">
                <li>
                  <div class="step-body">
                    <span>Download <code>slaprf-relay</code> (one file, no installer):</span>
                    <span class="livetime-downloads">${this.downloads()}</span>
                    <a class="link-inline" href="${RELEASES_URL}" target="_blank" rel="noopener">All downloads</a>
                  </div>
                </li>
                <li>
                  <div class="step-body">
                    <span>Run it on this computer and keep its window open. Windows: <em>More info → Run anyway</em>; macOS: <em>right-click → Open</em>; Linux/macOS terminal: <code>chmod +x slaprf-relay-*</code>. Allow network access if the firewall asks.</span>
                  </div>
                </li>
              </ol>
              <p class="note">If Chrome asks to access devices on your local network, choose <strong>Allow</strong> so this page can reach the local relay.</p>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>LiveTime setup</h2>
            <p>Add SlapRF in MultiGP LiveTime as an ImmersionRC LapRF 8-way timer. Loading a heat pushes pilot channels to every timer automatically.</p>
          </div>
          <div class="card">
            <div class="livetime">
              <ol class="steps">
                <li>
                  <div class="step-body">
                    <span>In MultiGP LiveTime, add a timing device of type</span>
                    <code>ImmersionRC LapRF (8-way)</code>.
                  </div>
                </li>
                <li>
                  <div class="step-body">
                    <span>Set the address to</span>
                    <code>127.0.0.1</code>
                    <span>(if LiveTime runs on this computer) or this computer's LAN IP, and port</span>
                    <code>${LIVETIME_PORT}</code>.
                  </div>
                </li>
                <li>
                  <div class="step-body">
                    <span>Load a heat: pilot Raceband channels are pushed to every timer automatically, and LiveTime controls race arming.</span>
                  </div>
                </li>
              </ol>
              <p class="note">Keep this tab open while racing. Only the start timer reports lap passes to LiveTime; other timers on the track record section splits.</p>
            </div>
          </div>
        </section>
      </div>`;

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action='relay-reconnect']");
      if (btn) this.relay.reconnect();
    });

    this.onDispose(store.subscribe(["status", "config", "laps", "crossings"], () => this.renderStatus()));
    this.onDispose(relay.subscribe(() => this.renderStatus()));
    const tick = window.setInterval(() => this.renderStatus(), 1000);
    this.onDispose(() => window.clearInterval(tick));
    this.renderStatus();
  }

  private downloads(): string {
    const os = detectOs();
    const ordered = [...RELAY_ASSETS].sort((a, b) => Number(b.os === os) - Number(a.os === os));
    return ordered
      .map(
        (a) =>
          `<a class="btn btn-sm ${a.os === os ? "btn-primary" : "btn-ghost"}" href="${RELEASES_URL}/download/${a.file}" download title="${a.file}">${a.label}</a>`
      )
      .join("");
  }

  private renderStatus(): void {
    const s = this.relay.snapshot;
    const lt = this.store.liveTime;
    const relayUp = s.relayState === "connected";
    const ltUp = relayUp && s.liveTimeState === "connected";

    const topLed = ltUp ? "is-up" : relayUp || s.relayState === "connecting" ? "is-warn" : "is-bad";
    const topText = ltUp
      ? `LiveTime connected${s.peer ? ` (${esc(s.peer)})` : ""} · race ${lt.raceArmedByHost ? "armed" : "stopped"} by LiveTime`
      : relayUp
        ? `Relay connected · waiting for MultiGP LiveTime on TCP :${LIVETIME_PORT}`
        : s.relayState === "connecting"
          ? `Connecting to local relay at ${LIVETIME_RELAY_URL}…`
          : s.lastError
            ? esc(s.lastError)
            : `Local relay not running · start slaprf-relay on this computer`;

    const relayBadge = relayUp
      ? `<span class="badge badge-good">Connected</span>`
      : s.relayState === "connecting"
        ? `<span class="badge badge-warn">Connecting</span>`
        : `<span class="badge badge-bad">Not running</span>`;

    const ltBadge = ltUp
      ? `<span class="badge badge-good">Connected</span>`
      : relayUp
        ? `<span class="badge badge-warn">Waiting</span>`
        : `<span class="badge">Offline</span>`;

    const lastSync =
      lt.lastRfSetupSync && !lt.lastRfSetupSync.startsWith("0001")
        ? new Date(lt.lastRfSetupSync).toLocaleTimeString()
        : "Never";

    const startNode = this.store.nodes.find((n) => n.role === "START_FINISH") ?? this.store.nodes[0];
    const startTimerText = startNode ? gateLabel(this.store, startNode.gateId) : "None";
    const replaced = s.lastError.startsWith("Another SlapRF tab");

    this.slot("status").innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${topLed}"></span>
          <span class="debug-head-note">${topText}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge mono">TCP :${LIVETIME_PORT}</span>
          <button type="button" class="btn btn-sm ${replaced ? "btn-armed" : "btn-ghost"}" data-action="relay-reconnect" title="Reconnect to local slaprf-relay">
            ${icons.reset(14)}<span>${replaced ? "Use this tab" : "Reconnect"}</span>
          </button>
        </div>
      </div>

      <div class="debug-timer-detail-grid">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${relayUp ? "is-active" : ""}">${icons.plug(14)}<span>Local relay (slaprf-relay)</span></span>
            ${relayBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Status</dt>
              <dd>${
                relayUp
                  ? "Connected to browser"
                  : s.relayState === "connecting"
                    ? "Connecting…"
                    : "Not reachable (start slaprf-relay below)"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Relay version</dt>
              <dd class="mono">${s.relayVersion ? esc(s.relayVersion) : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>WebSocket</dt>
              <dd class="mono">${LIVETIME_RELAY_URL}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Traffic</dt>
              <dd class="mono">${s.bytesIn.toLocaleString()} B in · ${s.bytesOut.toLocaleString()} B out</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${ltUp ? "is-active" : ""}">${icons.timer(14)}<span>MultiGP LiveTime</span></span>
            ${ltBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Client</dt>
              <dd class="mono">${ltUp ? esc(s.peer || "Connected") : relayUp ? `Listening on TCP :${LIVETIME_PORT}` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Race state</dt>
              <dd>${
                ltUp
                  ? lt.raceArmedByHost
                    ? `<span class="badge badge-good">Armed by LiveTime</span>`
                    : `<span class="badge">Stopped by LiveTime</span>`
                  : "—"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Passings sent</dt>
              <dd><span class="mono">${lt.detectionsSent.toLocaleString()}</span> <span class="note">· start timer ${esc(startTimerText)}</span></dd>
            </div>
            <div class="debug-kv-row">
              <dt>Last RF setup sync</dt>
              <dd class="mono">${esc(lastSync)}</dd>
            </div>
          </dl>
        </div>
      </div>`;
  }
}
