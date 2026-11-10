import { Component } from "../core/component";
import { esc } from "../core/format";
import {
  LIVETIME_PORT,
  LIVETIME_RELAY_URL,
  LiveTimeRelay,
  LiveTimeRelaySnapshot,
  sharedLiveTimeRelay,
} from "../services/livetime_relay";
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

/** MultiGP LiveTime: on/off switch, relay + LiveTime link status, and slaprf-relay setup steps. */
export class LiveTimeCard extends Component {
  private readonly store: AppStore;
  private readonly relay: LiveTimeRelay;

  constructor(el: HTMLElement, store: AppStore, relay: LiveTimeRelay = sharedLiveTimeRelay) {
    super(el);
    this.store = store;
    this.relay = relay;
    this.listen(el, "change", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-action='toggle-livetime']");
      if (input) this.relay.setEnabled(input.checked);
    });
    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action='relay-reconnect']");
      if (btn) this.relay.reconnect();
    });
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.onDispose(relay.subscribe(() => this.render()));
    this.render();
  }

  private relayRow(s: LiveTimeRelaySnapshot): string {
    let title: string;
    let dot = "";
    let sub = s.lastError || LIVETIME_RELAY_URL;
    switch (s.relayState) {
      case "connected":
        title = `Relay connected${s.relayVersion ? ` · ${esc(s.relayVersion)}` : ""}`;
        dot = "is-up";
        sub = `${LIVETIME_RELAY_URL} · ${s.bytesIn.toLocaleString()} B in · ${s.bytesOut.toLocaleString()} B out`;
        break;
      case "connecting":
        title = "Connecting to relay…";
        dot = "is-warn";
        break;
      default:
        title = "Relay not running";
        dot = "is-bad";
        if (!s.lastError) sub = `Start slaprf-relay on this computer (step 1–2 below).`;
    }
    const replaced = s.lastError.startsWith("Another SlapRF tab");
    return `
      <div class="livetime-status">
        <span class="status-dot ${dot}"></span>
        <div class="livetime-status-text">
          <div class="livetime-status-title">${title}</div>
          <div class="livetime-status-sub">${esc(sub)}</div>
        </div>
        ${replaced ? `<button type="button" class="btn btn-sm btn-ghost" data-action="relay-reconnect">Use this tab</button>` : ""}
      </div>`;
  }

  private liveTimeRow(s: LiveTimeRelaySnapshot): string {
    const lt = this.store.liveTime;
    const connected = s.relayState === "connected" && s.liveTimeState === "connected";
    const lastSync =
      lt.lastRfSetupSync && !lt.lastRfSetupSync.startsWith("0001")
        ? new Date(lt.lastRfSetupSync).toLocaleTimeString()
        : "never";
    const title = connected
      ? `LiveTime connected${s.peer ? ` from ${esc(s.peer)}` : ""}`
      : s.relayState === "connected"
        ? "Waiting for LiveTime"
        : "LiveTime not connected";
    const armed = connected ? ` · race ${lt.raceArmedByHost ? "armed" : "stopped"} by LiveTime` : "";
    return `
      <div class="livetime-status ${connected ? "is-up" : ""}">
        <span class="status-dot"></span>
        <div class="livetime-status-text">
          <div class="livetime-status-title">${title}</div>
          <div class="livetime-status-sub">${lt.detectionsSent.toLocaleString()} passings sent · last RF setup sync ${lastSync}${armed}</div>
        </div>
      </div>`;
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

  private render(): void {
    const s = this.relay.snapshot;

    this.el.innerHTML = `
      <div class="livetime">
        <div class="option-row">
          <div>
            <div class="option-title">LiveTime integration</div>
            <div class="option-sub">Emulates an ImmersionRC LapRF 8-way timer so MultiGP LiveTime can sync pilot channels, start and stop races, and receive start-gate lap passings. Needs the small <code>slaprf-relay</code> helper running on this computer.</div>
          </div>
          <label class="switch switch-lg"><input type="checkbox" data-action="toggle-livetime" ${s.enabled ? "checked" : ""} /><span></span></label>
        </div>
        ${
          s.enabled
            ? `
        <div class="livetime-body">
          ${this.relayRow(s)}
          ${this.liveTimeRow(s)}
          <ol class="steps">
            <li><div class="step-body"><span>Download <code>slaprf-relay</code> (one file, no installer):</span><span class="livetime-downloads">${this.downloads()}</span><a class="link-inline" href="${RELEASES_URL}" target="_blank" rel="noopener">All downloads</a></div></li>
            <li><div class="step-body"><span>Run it on this computer and keep its window open. Windows: <em>More info → Run anyway</em>; macOS: <em>right-click → Open</em>; Linux/macOS terminal: <code>chmod +x slaprf-relay-*</code>. Allow network access if the firewall asks.</span></div></li>
            <li><div class="step-body"><span>In LiveTime, add a timing device of type</span> <code>ImmersionRC LapRF (8-way)</code> <span>at this computer's IP address, port</span> <code>${LIVETIME_PORT}</code> <span>(use</span> <code>127.0.0.1</code> <span>if LiveTime runs on this computer).</span></div></li>
            <li><div class="step-body"><span>Load a heat — pilot channels are pushed to every gate automatically.</span></div></li>
          </ol>
          <p class="note">Chrome may ask to let this site access devices on your local network — choose <strong>Allow</strong> so the page can reach the relay. One LiveTime connection at a time. Keep this tab open while racing. Only the start gate reports laps to LiveTime; sector gates feed Pilot insights.</p>
        </div>`
            : ""
        }
      </div>`;
  }
}
