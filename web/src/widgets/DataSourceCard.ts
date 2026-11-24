import {
  downloadTextFile,
  getAndroidLanStatus,
  isAndroidHostApp,
  setAndroidLanEnabled,
} from "../core/android_bridge";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { buildPracticeHash } from "../core/router";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import {
  clearActiveAuthSession,
  clearRememberedAuthCredentials,
  fetchServerAuthConfig,
  getDemoAuthConfig,
  getRememberedAuthCredentials,
  saveDemoAuthConfig,
  saveServerAuthConfig,
} from "../services/auth";
import {
  capabilitiesSnapshot,
  connectionLostSnapshot,
  connectToBackend,
  consumeDatasourceIntent,
  DatasourceServerIntent,
  DEFAULT_LOCAL_SERVER_URL,
  disconnectFromBackend,
  discoverLocalServer,
  getDatasourceUiMode,
  getRecentBackendUrls,
  orderedPortableAssets,
  PORTABLE_RELEASES_URL,
  probeBackendCandidate,
  removeRecentBackendUrl,
  resolveBackendUrl,
  setDatasourceUiMode,
  subscribeCapabilities,
  subscribeDatasourceIntent,
} from "../services/capabilities";
import { enginePersistence, formatBytes, getLastBackupAt, recordBackupNow } from "../services/engine_persistence";
import { sharedMultiGPService } from "../services/multigp_service";
import { getStorageStatus, StorageStatus } from "../services/offline";
import { AppStore } from "../state/store";
import { openConfirmModal } from "./ConfirmModal";
import { preloadDiagnosticsStatus } from "./DiagnosticsSettings";

interface BackendStorageStatus {
  backend: string;
  dbPath: string;
  sizeBytes: number;
  savedAtMs: number;
  lastBackupAtMs?: number;
  realLapsCount: number;
  simLapsCount: number;
}

let cachedBackendStorageStatus: BackendStorageStatus | null = null;
let cachedStorageStatus: StorageStatus | null = null;
let cachedAuthConfig: {
  enabled: boolean;
  username: string;
  hasPassword: boolean;
  password?: string;
} | null = null;

export function preloadSettingsStatuses(): void {
  const caps = capabilitiesSnapshot();
  if (caps.portable) {
    void fetch(resolveBackendUrl("/v1/storage/status"), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (resp) => {
        if (!resp.ok) return;
        cachedBackendStorageStatus = (await resp.json()) as BackendStorageStatus;
      })
      .catch(() => undefined);
    preloadDiagnosticsStatus();
    void fetchServerAuthConfig(caps.backendBaseUrl)
      .then((cfg) => {
        cachedAuthConfig = cfg;
      })
      .catch(() => undefined);
  } else {
    void getStorageStatus()
      .then((s) => {
        cachedStorageStatus = s;
      })
      .catch(() => undefined);
    cachedAuthConfig = getDemoAuthConfig();
  }
}

function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "never";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

/** Toggle between standalone Demo mode and a SlapRF Server backend, plus track simulation controls. */
export class DataSourceCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private selectedMode: "demo" | "server";
  private serverInputUrl: string;
  private connecting = false;
  private discoveringLocal = false;
  private localDiscoverySearched = false;
  private connectError = "";
  private mixedContentDirectUrl = "";
  private noticeReason: "none" | "real-hardware" = "none";
  private lastSig = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    const initialCaps = capabilitiesSnapshot();
    const initialIntent = consumeDatasourceIntent();
    this.selectedMode =
      initialCaps.portable ||
      getDatasourceUiMode() === "server" ||
      initialIntent === "connect" ||
      initialIntent === "real-hardware"
        ? "server"
        : "demo";
    if (!initialCaps.portable && this.selectedMode === "server") {
      setDatasourceUiMode("server");
    }
    if (initialIntent === "real-hardware" && initialCaps.demoMode) {
      this.noticeReason = "real-hardware";
    }
    this.serverInputUrl =
      initialCaps.remoteBackend && initialCaps.backendBaseUrl
        ? initialCaps.backendBaseUrl
        : initialCaps.localDetectedUrl || getRecentBackendUrls()[0] || DEFAULT_LOCAL_SERVER_URL;

    el.addEventListener("change", this.handleChange);
    el.addEventListener("click", this.handleClick);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("keydown", this.handleKeyDown);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("keydown", this.handleKeyDown);
      if (!capabilitiesSnapshot().portable && !connectionLostSnapshot().lost) {
        setDatasourceUiMode("demo");
      }
    });
    this.onDispose(store.subscribe(["status", "config", "sim"], () => this.render()));
    this.onDispose(
      subscribeCapabilities((caps) => {
        if (caps.portable) {
          this.selectedMode = "server";
          this.noticeReason = "none";
          if (caps.remoteBackend && caps.backendBaseUrl) {
            this.serverInputUrl = caps.backendBaseUrl;
          }
        } else {
          this.selectedMode = getDatasourceUiMode();
          if (caps.localDetectedUrl && this.serverInputUrl === DEFAULT_LOCAL_SERVER_URL) {
            this.serverInputUrl = caps.localDetectedUrl;
          } else if (this.selectedMode === "server") {
            const recent0 = getRecentBackendUrls()[0];
            if (recent0 && this.serverInputUrl === DEFAULT_LOCAL_SERVER_URL) {
              this.serverInputUrl = recent0;
            }
          }
        }
        this.render();
      })
    );
    this.onDispose(subscribeDatasourceIntent((intent) => this.applyIntent(intent)));
    this.render();
    if (initialIntent === "connect" || initialIntent === "real-hardware") {
      this.focusServerInput();
    }
  }

  private applyIntent(intent: DatasourceServerIntent): void {
    consumeDatasourceIntent();
    const caps = capabilitiesSnapshot();
    if (intent === "real-hardware" || intent === "connect") {
      this.selectedMode = "server";
      if (!caps.portable) {
        setDatasourceUiMode("server");
      }
      this.noticeReason = intent === "real-hardware" && caps.demoMode ? "real-hardware" : "none";
      this.connectError = "";
      this.mixedContentDirectUrl = "";
      this.forceRender();
      this.focusServerInput();
    } else if (intent === "inspect") {
      this.noticeReason = "none";
      this.selectedMode = caps.portable ? "server" : getDatasourceUiMode();
      this.forceRender();
    }
  }

  private focusServerInput(): void {
    window.requestAnimationFrame(() => {
      const inp = this.el.querySelector<HTMLInputElement>('[data-field="backend-url"]');
      if (inp && !inp.disabled) {
        inp.focus();
        inp.select();
      }
    });
  }

  private forceRender(): void {
    this.lastSig = "";
    this.render();
  }

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement | null;
    if (target?.dataset.field === "backend-url") {
      this.serverInputUrl = target.value;
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLInputElement | null;
    if (e.key === "Enter" && target?.dataset.field === "backend-url") {
      e.preventDefault();
      void this.submitBackendUrl(target.value);
    }
  };

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.name === "android-lan") {
      setAndroidLanEnabled(target.checked);
      this.forceRender();
      return;
    }
    if (target.name === "simulator") {
      const caps = capabilitiesSnapshot();
      if (!caps.portable) {
        target.checked = false;
        return;
      }
      void this.api.toggleSimulator();
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as Element | null;
    const speedBtn = target?.closest<HTMLButtonElement>("[data-sim-speed]");
    if (speedBtn && !speedBtn.disabled) {
      const mult = Number(speedBtn.dataset.simSpeed);
      if (Number.isFinite(mult) && mult >= 1) {
        void this.api.setSimSpeed(mult);
      }
      return;
    }

    const modeBtn = target?.closest<HTMLButtonElement>("[data-backend-mode]");
    if (modeBtn && !modeBtn.disabled) {
      const nextMode = modeBtn.dataset.backendMode === "server" ? "server" : "demo";
      const caps = capabilitiesSnapshot();
      if (nextMode === "demo") {
        if (caps.portable && caps.remoteBackend) {
          disconnectFromBackend();
          return;
        }
        if (!caps.portable) {
          this.selectedMode = "demo";
          this.noticeReason = "none";
          this.connectError = "";
          this.mixedContentDirectUrl = "";
          setDatasourceUiMode("demo");
          void this.api.ensureDemoModeActive?.();
          this.forceRender();
        }
      } else {
        this.selectedMode = "server";
        this.connectError = "";
        this.mixedContentDirectUrl = "";
        if (!caps.portable) {
          setDatasourceUiMode("server");
        }
        this.forceRender();
        if (!caps.portable) {
          this.focusServerInput();
        }
      }
      return;
    }

    const actionBtn = target?.closest<HTMLElement>("[data-action]");
    if (!actionBtn) return;
    switch (actionBtn.dataset.action) {
      case "backend-connect-submit": {
        const inp = this.el.querySelector<HTMLInputElement>('[data-field="backend-url"]');
        void this.submitBackendUrl(inp ? inp.value : this.serverInputUrl);
        break;
      }
      case "discover-local-app": {
        void this.handleDiscoverLocalApp();
        break;
      }
      case "backend-connect-quick":
      case "connect-detected-local": {
        if (actionBtn.dataset.url) {
          this.selectedMode = "server";
          if (!capabilitiesSnapshot().portable) {
            setDatasourceUiMode("server");
          }
          void this.submitBackendUrl(actionBtn.dataset.url);
        }
        break;
      }
      case "backend-remove-recent": {
        if (actionBtn.dataset.url) {
          removeRecentBackendUrl(actionBtn.dataset.url);
          this.forceRender();
        }
        break;
      }
      case "disconnect-remote-backend":
        disconnectFromBackend();
        break;
    }
  };

  private async handleDiscoverLocalApp(): Promise<void> {
    if (this.connecting || this.discoveringLocal) return;
    this.discoveringLocal = true;
    this.localDiscoverySearched = false;
    this.connectError = "";
    this.mixedContentDirectUrl = "";
    this.forceRender();

    const detectedUrl = await discoverLocalServer(2000);
    this.discoveringLocal = false;
    this.localDiscoverySearched = true;
    if (detectedUrl) {
      this.serverInputUrl = detectedUrl;
    }
    this.forceRender();
  }

  private async submitBackendUrl(rawTarget: string): Promise<void> {
    if (this.connecting) return;
    const connectingFromDisconnected = !capabilitiesSnapshot().portable;
    this.serverInputUrl = rawTarget;
    this.connecting = true;
    this.connectError = "";
    this.mixedContentDirectUrl = "";
    this.forceRender();

    const probe = await probeBackendCandidate(rawTarget);
    if (!probe.ok) {
      this.connecting = false;
      this.connectError = probe.error || "Unable to connect to SlapRF Server.";
      if (probe.mixedContentBlocked && probe.normalizedUrl) {
        this.mixedContentDirectUrl = probe.normalizedUrl;
      }
      this.forceRender();
      return;
    }

    try {
      await connectToBackend(probe.normalizedUrl, {
        disableSimOnConnect: connectingFromDisconnected,
      });
    } catch (err) {
      this.connecting = false;
      this.connectError = err instanceof Error ? err.message : String(err);
      this.forceRender();
    }
  }

  private render(): void {
    const sim = this.store.simulatorRunning;
    const simSpeed = this.store.simState?.speedMultiplier ?? 1;
    const caps = capabilitiesSnapshot();
    const effectiveMode: "demo" | "server" = caps.portable ? "server" : this.selectedMode;
    const recents = getRecentBackendUrls();

    const androidApp = isAndroidHostApp();
    const androidLan = androidApp ? getAndroidLanStatus() : null;
    const sig = `${sim ? "1" : "0"}|${sim ? simSpeed : 0}|${caps.portable ? 1 : 0}|${caps.remoteBackend ? 1 : 0}|${caps.backendBaseUrl}|${caps.hostname}|${caps.version}|${caps.localDetectedUrl ?? ""}|${caps.lanIPs.join(",")}|${effectiveMode}|${this.connecting ? 1 : 0}|${this.discoveringLocal ? 1 : 0}|${this.localDiscoverySearched ? 1 : 0}|${this.connectError}|${this.mixedContentDirectUrl}|${this.noticeReason}|${recents.join(",")}|${androidLan ? `${androidLan.enabled ? 1 : 0}:${androidLan.port}:${androidLan.urls.join(",")}:${androidLan.error ?? ""}` : ""}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const assets = orderedPortableAssets();
    const primaryAsset = assets[0];
    const isDirectServerOrigin = caps.portable && !caps.remoteBackend;

    const modeSubtitle = caps.portable
      ? `Connected to native Go server (<span class="mono">${esc(caps.backendBaseUrl || window.location.origin)}</span> · v${esc(caps.version)}). Engines, <span class="mono">slaprf.db</span> persistence, native USB-C serial &amp; flasher, LapRF 8-Way, and RotorHazard run on the server.`
      : effectiveMode === "server"
        ? `Connect to a local (<span class="mono">127.0.0.1:8090</span>) or LAN / Raspberry Pi <strong>SlapRF Server</strong> for native performance, <span class="mono">slaprf.db</span> storage, and physical timing hardware.`
        : `Running standalone in your browser with no backend server. Switch to <strong>Server</strong> to connect a local or LAN SlapRF Server for persistent storage and physical timing hardware.`;

    const recentsHtml =
      recents.length > 0
        ? `<div class="datasource-recents">
             <span class="note">Recent:</span>
             ${recents
               .map(
                 (u) => `
                   <span class="datasource-recent-chip">
                     <button type="button" class="btn btn-ghost btn-xs mono" data-action="backend-connect-quick" data-url="${esc(u)}" ${this.connecting ? "disabled" : ""}>${esc(u)}</button>
                     <button type="button" class="btn btn-ghost btn-xs" data-action="backend-remove-recent" data-url="${esc(u)}" aria-label="Remove ${esc(u)}" title="Remove">${icons.close(12)}</button>
                   </span>`
               )
               .join("")}
           </div>`
        : "";

    const autoDiscoveryHtml = `
      <div class="datasource-server-subsection" data-datasource-subsection="auto-discovery">
        <div class="datasource-subsection-head">
          <div>
            <div class="option-title">Auto Discovery</div>
            <div class="option-sub">Check this computer (<span class="mono">127.0.0.1:8090</span>) for a running SlapRF server.</div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="discover-local-app" ${this.connecting || this.discoveringLocal ? "disabled" : ""} title="Check 127.0.0.1:8090 for a local SlapRF server running on this computer">
            ${icons.search(14)}<span>${this.discoveringLocal ? "Searching…" : "Discover Local Server"}</span>
          </button>
        </div>
        ${
          caps.localDetectedUrl
            ? `<div class="datasource-detected-row" data-discovered-server-row>
                 <div style="display:flex;align-items:center;gap:7px;min-width:0">
                   <span class="status-dot is-up"></span>
                   <span class="option-sub">Local SlapRF Server detected at <span class="mono">${esc(caps.localDetectedUrl)}</span></span>
                 </div>
                 <button type="button" class="btn btn-armed btn-sm" data-action="backend-connect-quick" data-url="${esc(caps.localDetectedUrl)}" ${this.connecting ? "disabled" : ""}>
                   ${icons.plug(14)}<span>Connect</span>
                 </button>
               </div>`
            : this.localDiscoverySearched && !this.discoveringLocal
              ? `<div class="datasource-discovery-empty note" data-discovery-empty>No local SlapRF server detected at <span class="mono">${esc(DEFAULT_LOCAL_SERVER_URL)}</span>. Make sure <span class="mono">slaprf</span> is running on this computer, or use Manual Connection below.</div>`
              : ""
        }
      </div>`;

    let serverDetailsHtml = "";
    if (caps.portable) {
      serverDetailsHtml = `
        <div class="datasource-server-panel">
          <div class="datasource-server-status">
            <div class="datasource-server-status-main">
              <div class="option-title" style="display:flex;align-items:center;gap:7px">
                <span class="status-dot is-up"></span>
                <span>Connected${caps.hostname ? ` · ${esc(caps.hostname)}` : ""}</span>
              </div>
              <div class="option-sub mono">
                ${esc(caps.backendBaseUrl || window.location.origin)} · v${esc(caps.version)} · bbolt (slaprf.db)
              </div>
              ${
                !androidApp && caps.lanIPs.length > 0
                  ? `<div class="option-sub" style="margin-top:4px">LAN multi-display URLs: ${caps.lanIPs
                      .map((ip) => `<span class="mono">http://${esc(ip)}:8090</span>`)
                      .join(", ")}</div>`
                  : androidApp && androidLan?.enabled && androidLan.urls.length > 0
                    ? `<div class="option-sub" style="margin-top:4px">LAN multi-display URLs: ${androidLan.urls
                        .map((u) => `<span class="mono">${esc(u)}</span>`)
                        .join(", ")}</div>`
                    : ""
              }
            </div>
          </div>
          ${
            caps.remoteBackend
              ? `${autoDiscoveryHtml}
                 <div class="datasource-server-subsection datasource-server-form" data-datasource-subsection="manual-connection">
                   <label class="option-title" for="slaprf-backend-url-input" style="display:block">Manual Connection</label>
                   <div class="datasource-url-row">
                     <input
                       id="slaprf-backend-url-input"
                       type="text"
                       class="input mono"
                       data-field="backend-url"
                       placeholder="127.0.0.1:8090 or 192.168.1.50:8090"
                       value="${esc(this.serverInputUrl)}"
                       autocomplete="off"
                       spellcheck="false"
                       ${this.connecting || this.discoveringLocal ? "disabled" : ""}
                     />
                     <button type="button" class="btn btn-unarmed" data-action="backend-connect-submit" ${this.connecting || this.discoveringLocal ? "disabled" : ""}>
                       ${icons.check(15)}<span>${this.connecting ? "Connecting…" : "Switch server"}</span>
                     </button>
                   </div>
                   ${this.connectError ? `<div class="storage-status-error" data-backend-error>${esc(this.connectError)}</div>` : ""}
                   ${recentsHtml}
                 </div>`
              : ""
          }
        </div>`;
    } else if (effectiveMode === "server") {
      serverDetailsHtml = `
        <div class="datasource-server-panel">
          ${
            this.noticeReason === "real-hardware"
              ? `<div class="datasource-inline-notice" data-datasource-notice="real-hardware">
                   <strong>Real-hardware timing requires a SlapRF Server.</strong> Enter your local (<span class="mono">127.0.0.1:8090</span>) or LAN (<span class="mono">192.168.x.x:8090</span>) server address below to connect.
                 </div>`
              : ""
          }
          ${autoDiscoveryHtml}
          <div class="datasource-server-subsection datasource-server-form" data-datasource-subsection="manual-connection">
            <label class="option-title" for="slaprf-backend-url-input" style="display:block">Manual Connection</label>
            <div class="option-sub">
              Enter <span class="mono">127.0.0.1:8090</span> for a server on this computer, or <span class="mono">192.168.x.x:8090</span> for a trackside Raspberry Pi / LAN server started with <span class="mono">slaprf -lan</span>.
            </div>
            <div class="datasource-url-row">
              <input
                id="slaprf-backend-url-input"
                type="text"
                class="input mono"
                data-field="backend-url"
                placeholder="127.0.0.1:8090 or 192.168.1.50:8090"
                value="${esc(this.serverInputUrl)}"
                autocomplete="off"
                spellcheck="false"
                ${this.connecting || this.discoveringLocal ? "disabled" : ""}
              />
              <button type="button" class="btn btn-primary" data-action="backend-connect-submit" ${this.connecting || this.discoveringLocal ? "disabled" : ""}>
                ${icons.check(15)}<span>${this.connecting ? "Connecting…" : "Connect"}</span>
              </button>
            </div>
            ${this.connectError ? `<div class="storage-status-error" data-backend-error>${esc(this.connectError)}</div>` : ""}
            ${
              this.mixedContentDirectUrl
                ? `<div>
                     <a class="btn btn-armed btn-sm" href="${esc(this.mixedContentDirectUrl)}" rel="noopener">
                       ${icons.link(14)}<span>Open Track Server UI (${esc(this.mixedContentDirectUrl)})</span>
                     </a>
                   </div>`
                : ""
            }
            ${recentsHtml}
          </div>
          <div class="datasource-download-foot">
            <span class="note">Don't have the server binary yet? Run <span class="mono">./slaprf</span> locally or <span class="mono">./slaprf -lan -no-browser</span> on a Raspberry Pi.</span>
            <a class="btn btn-ghost btn-sm" href="${PORTABLE_RELEASES_URL}" target="_blank" rel="noopener noreferrer">
              ${icons.download(14)}<span>${esc(primaryAsset ? primaryAsset.label : "Download Server")}</span>
            </a>
          </div>
        </div>`;
    } else if (caps.localDetectedUrl) {
      serverDetailsHtml = `
        <div class="datasource-server-panel">
          <div class="datasource-detected-row">
            <div style="display:flex;align-items:center;gap:7px;min-width:0">
              <span class="status-dot is-up"></span>
              <span class="option-sub">Local SlapRF Server detected at <span class="mono">${esc(caps.localDetectedUrl)}</span></span>
            </div>
            <button type="button" class="btn btn-armed btn-sm" data-action="connect-detected-local" data-url="${esc(caps.localDetectedUrl)}" ${this.connecting ? "disabled" : ""}>
              ${icons.plug(14)}<span>Connect Local Server</span>
            </button>
          </div>
        </div>`;
    }

    const serverCardHtml = `
      <div class="card" data-backend-server-card="${caps.portable ? "connected" : effectiveMode}">
        <div class="option-row">
          <div>
            <div class="option-title">Backend</div>
            <div class="option-sub">${modeSubtitle}</div>
          </div>
          <div class="option-actions">
            <div class="segmented" role="group" aria-label="Backend mode" data-backend-mode-toggle>
              <button
                type="button"
                class="${effectiveMode === "demo" ? "is-active" : ""}"
                data-backend-mode="demo"
                ${
                  isDirectServerOrigin
                    ? 'disabled title="Hosted directly by the local SlapRF Server — use Simulation active below to run simulated races"'
                    : 'title="Run standalone in the browser with no backend server"'
                }
              >Demo</button>
              <button
                type="button"
                class="${effectiveMode === "server" ? "is-active" : ""}"
                data-backend-mode="server"
                title="Connect to a local or LAN SlapRF Server backend"
              >Server</button>
            </div>
          </div>
        </div>
        ${serverDetailsHtml}
      </div>`;

    const disconnectedServerLock = !caps.portable && effectiveMode === "server";
    const effectiveSim = disconnectedServerLock ? false : sim;

    const simSpeedCardHtml = effectiveSim
      ? `<div class="card">
          <div class="option-row">
            <div>
              <div class="option-title">Simulation speed</div>
              <div class="option-sub">Accelerate simulated heats, lap crossings, and flight pack discharge while testing tournaments or practice sessions.</div>
            </div>
            <div class="option-actions">
              <div class="segmented sim-speed-seg" role="group" aria-label="Simulation speed">
                <button type="button" class="${simSpeed < 3 ? "is-active" : ""}" data-sim-speed="1" title="Real-time simulation (1×)">1×</button>
                <button type="button" class="${simSpeed >= 3 && simSpeed < 15 ? "is-active" : ""}" data-sim-speed="5" title="Fast simulation (5×)">5×</button>
                <button type="button" class="${simSpeed >= 15 ? "is-active" : ""}" data-sim-speed="20" title="Fast heats simulation (20× — finishes heats in ~2–3s)">20×</button>
              </div>
            </div>
          </div>
        </div>`
      : "";

    const simActiveCardHtml =
      effectiveMode === "server"
        ? `<div class="card ${disconnectedServerLock ? "is-server-locked" : ""}" data-sim-active-card="${disconnectedServerLock ? "locked" : "ready"}">
          <div class="option-row">
            <div>
              <div class="option-title">Simulation active</div>
              <div class="option-sub">Runs simulated pilots, timers, and 6S flight packs in a separate dataset. Turn off to time laps with physical hardware on the <a href="#/network" class="link-inline" ${disconnectedServerLock ? 'tabindex="-1" aria-disabled="true"' : ""}>Network</a> page.</div>
            </div>
            <div class="option-actions">
              <label class="switch switch-lg">
                <input type="checkbox" name="simulator" ${effectiveSim ? "checked" : ""} ${disconnectedServerLock ? "disabled" : ""} />
                <span></span>
              </label>
            </div>
          </div>
        </div>`
        : "";

    const androidLanCardHtml =
      androidApp && caps.portable && !caps.remoteBackend
        ? `<div class="card" data-android-lan-card>
          <div class="option-row">
            <div>
              <div class="option-title">Share server on Wi-Fi / Hotspot</div>
              <div class="option-sub">Allow other phones, tablets, and laptops on the same Wi-Fi network or phone Hotspot to open live races, brackets, and standings.${
                androidLan?.enabled
                  ? androidLan.urls.length > 0
                    ? ` Share URL: ${androidLan.urls.map((u) => `<span class="mono">${esc(u)}</span>`).join(", ")}`
                    : ` Listening on port <span class="mono">:${androidLan.port || 8090}</span> (connect to Wi-Fi or turn on Hotspot).`
                  : ""
              }</div>
              ${androidLan?.error ? `<div class="storage-status-error" style="margin-top:6px">${esc(androidLan.error)}</div>` : ""}
            </div>
            <div class="option-actions">
              <label class="switch switch-lg">
                <input type="checkbox" name="android-lan" data-android-lan-toggle ${androidLan?.enabled ? "checked" : ""} />
                <span></span>
              </label>
            </div>
          </div>
        </div>`
        : "";

    this.el.innerHTML = `
      ${serverCardHtml}
      ${androidLanCardHtml}
      ${simActiveCardHtml}
      ${simSpeedCardHtml}`;
  }
}

/** MultiGP Chapter API Key verification & auto-sync settings card. */
export class MultiGPSettingsCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private busy = false;
  private statusMsg = "";
  private errorMsg = "";
  private revealKey = false;
  private lastSig = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    el.addEventListener("click", this.handleClick);
    el.addEventListener("change", this.handleChange);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("keydown", this.handleKeyDown);
    this.onDispose(() => {
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("keydown", this.handleKeyDown);
    });
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.onDispose(sharedMultiGPService.subscribe(() => this.render()));
    this.onDispose(subscribeCapabilities(() => this.render()));
    this.render();
  }

  private handleInput = (e: Event): void => {
    const t = e.target as HTMLInputElement;
    if (t.name === "mgp-api-key") {
      this.statusMsg = "";
      this.errorMsg = "";
      sharedMultiGPService.setApiKey(this.store.simulatorRunning, t.value);
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLInputElement;
    if (t.name === "mgp-api-key" && e.key === "Enter") {
      e.preventDefault();
      void this.verifyNow(t.value);
    }
  };

  private handleChange = (e: Event): void => {
    const t = e.target as HTMLInputElement;
    if (t.name === "mgp-auto-push") {
      sharedMultiGPService.setAutoPushOnConfirm(this.store.simulatorRunning, t.checked);
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!btn) return;
    const act = btn.dataset.action;

    if (act === "toggle-reveal") {
      this.revealKey = !this.revealKey;
      const inp = this.el.querySelector<HTMLInputElement>('input[name="mgp-api-key"]');
      if (inp) {
        inp.type = this.revealKey ? "text" : "password";
      }
      const label = this.revealKey ? "Hide API key" : "Reveal API key";
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.innerHTML = this.revealKey ? icons.eyeOff(15) : icons.eye(15);
      this.lastSig = "";
      return;
    }
    if (act === "verify-mgp") {
      const inp = this.el.querySelector<HTMLInputElement>('input[name="mgp-api-key"]');
      void this.verifyNow(inp?.value);
      return;
    }
    if (act === "restore-mgp-defaults") {
      this.statusMsg = "";
      this.errorMsg = "";
      this.lastSig = "";
      sharedMultiGPService.resetDefaults(this.store.simulatorRunning, this.store);
    }
  };

  private async verifyNow(explicitKey?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.errorMsg = "";
    this.statusMsg = "";
    this.lastSig = "";
    this.render();
    try {
      const res = await sharedMultiGPService.verifyChapterKey(this.store, this.api, explicitKey);
      this.statusMsg = `Verified chapter: ${res.chapterName}${res.chapterId ? ` (#${res.chapterId})` : ""}`;
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
      this.lastSig = "";
      this.render();
    }
  }

  private render(): void {
    const active = document.activeElement;
    if (
      !this.busy &&
      active instanceof HTMLInputElement &&
      active.name === "mgp-api-key" &&
      this.el.contains(active)
    ) {
      return;
    }

    const isSim = this.store.simulatorRunning;
    const prefs = sharedMultiGPService.prefsFor(isSim, this.store);

    const sig = JSON.stringify({
      isSim,
      apiKey: prefs.apiKey,
      verified: prefs.verified,
      chapterId: prefs.chapterId,
      chapterName: prefs.chapterName,
      autoPush: prefs.autoPushOnConfirm,
      busy: this.busy,
      reveal: this.revealKey,
      status: this.statusMsg,
      err: this.errorMsg,
    });
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const badgeText =
      prefs.verified && prefs.chapterName
        ? `Connected to <strong>${esc(prefs.chapterName)}</strong>${prefs.chapterId ? ` <span class="mono">(#${prefs.chapterId})</span>` : ""}`
        : `Enter your Chapter WebService API key (Chapter Settings → RaceSync API Key) and click Verify.`;

    const eyeLabel = this.revealKey ? "Hide API key" : "Reveal API key";

    this.el.innerHTML = `
      <div class="card card-flush">
        <div class="card-body">
          <div class="option-row mgp-key-row">
            <div class="mgp-key-info">
              <div class="option-title">Chapter API key</div>
              <div class="option-sub">${badgeText}</div>
              ${this.statusMsg ? `<div class="option-sub" style="margin-top:6px;color:var(--text)">${esc(this.statusMsg)}</div>` : ""}
              ${this.errorMsg ? `<div class="storage-status-error" style="margin-top:6px">${esc(this.errorMsg)}</div>` : ""}
            </div>
            <div class="option-actions mgp-key-actions">
              <div class="flasher-pass-wrap">
                <input
                  type="${this.revealKey ? "text" : "password"}"
                  name="mgp-api-key"
                  class="input flasher-pass-input mono"
                  placeholder="Paste Chapter API Key"
                  value="${esc(prefs.apiKey)}"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="MultiGP Chapter API Key"
                />
                <button
                  type="button"
                  class="flasher-pass-toggle"
                  data-action="toggle-reveal"
                  aria-label="${eyeLabel}"
                  title="${eyeLabel}"
                >
                  ${this.revealKey ? icons.eyeOff(15) : icons.eye(15)}
                </button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" data-action="verify-mgp" ${this.busy ? "disabled" : ""}>
                ${this.busy ? "Verifying…" : "Verify"}
              </button>
            </div>
          </div>
        </div>
        <div class="rules-foot">
          <p class="note">Used to list chapter races, import pilot rosters, pull ZippyQ rounds, and upload race results.</p>
          <button class="btn btn-ghost btn-sm" type="button" data-action="restore-mgp-defaults">Restore defaults</button>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Auto-sync confirmed heats</div>
            <div class="option-sub">Automatically push completed heat lap times to MultiGP when you confirm a heat in a MultiGP-linked race.</div>
          </div>
          <div class="option-actions">
            <label class="switch switch-lg">
              <input type="checkbox" name="mgp-auto-push" ${prefs.autoPushOnConfirm ? "checked" : ""} />
              <span></span>
            </label>
          </div>
        </div>
      </div>`;
  }
}

/** Persistence section: storage status (`bbolt` `slaprf.db` or `IndexedDB`) + Export backup, Import, and Wipe sub-cards. */
export class PersistenceSettings extends Component {
  private readonly api: ApiClient;
  private readonly announcer?: Announcer;
  private storage: StorageStatus | null = cachedStorageStatus;
  private backendStorage: BackendStorageStatus | null = cachedBackendStorageStatus;
  private storageFetchedAt = 0;

  constructor(el: HTMLElement, api: ApiClient, announcer?: Announcer) {
    super(el);
    this.api = api;
    this.announcer = announcer;
    el.addEventListener("change", this.handleChange);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(enginePersistence.subscribe(() => this.refreshStorage(false)));
    this.onDispose(
      subscribeCapabilities(() => {
        this.render();
        this.refreshStorage(true);
      })
    );
    const tick = window.setInterval(() => this.refreshStorage(true), 8_000);
    this.onDispose(() => window.clearInterval(tick));
    this.render();
    this.refreshStorage(true);
  }

  /** Re-reads storage status from either the Go `bbolt` server (`GET /v1/storage/status`) or browser IndexedDB. */
  private refreshStorage(force: boolean): void {
    this.renderStatus();
    if (!force && performance.now() - this.storageFetchedAt < 4000) return;
    this.storageFetchedAt = performance.now();

    if (capabilitiesSnapshot().portable) {
      void fetch(resolveBackendUrl("/v1/storage/status"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      })
        .then(async (resp) => {
          if (!resp.ok) return;
          this.backendStorage = (await resp.json()) as BackendStorageStatus;
          cachedBackendStorageStatus = this.backendStorage;
          this.renderStatus();
        })
        .catch(() => undefined);
      return;
    }

    void getStorageStatus().then((s) => {
      this.storage = s;
      cachedStorageStatus = s;
      this.renderStatus();
    });
  }

  private renderStatus(): void {
    const host = this.el.querySelector<HTMLElement>("[data-storage-status]");
    if (!host) return;

    if (capabilitiesSnapshot().portable) {
      const bs = this.backendStorage;
      if (!bs) {
        host.innerHTML = `Storage: <strong>bbolt (slaprf.db)</strong> · loading…`;
        return;
      }
      const backupAt = bs.lastBackupAtMs || getLastBackupAt();
      const parts = [
        `Storage: <strong>bbolt (slaprf.db)</strong> · saving`,
        bs.dbPath ? `file: <span class="mono">${esc(bs.dbPath)}</span>` : "",
        `size: ${formatBytes(bs.sizeBytes)}`,
        `laps: ${bs.realLapsCount} real / ${bs.simLapsCount} sim`,
        `last saved: ${fmtWhen(bs.savedAtMs)}`,
        `last backup: ${fmtWhen(backupAt)}`,
      ].filter(Boolean);
      host.innerHTML = parts.join(" · ");
      return;
    }

    const st = enginePersistence.getStatus();
    const s = this.storage;
    const modeLabel: Record<string, string> = {
      booting: "starting…",
      active: "saving",
      "read-only": "read-only (open in another tab)",
      unavailable: "not saving",
    };
    const parts = [
      `Storage: <strong>${st.backend}</strong> · ${modeLabel[st.mode] ?? st.mode}`,
      `persisted: ${s ? (s.persisted ? "yes" : "no") : "…"}`,
      `used: ${s ? `${formatBytes(s.usage)} / ${formatBytes(s.quota)}` : "…"}`,
      `last saved: ${fmtWhen(st.lastSavedAt)}`,
      `last backup: ${fmtWhen(getLastBackupAt())}`,
    ];
    host.innerHTML =
      parts.join(" · ") +
      (st.lastError ? `<div class="storage-status-error">${esc(st.lastError)}</div>` : "");
  }

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.matches("[data-import-input]")) {
      const input = target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) {
        void this.handleImportFile(file);
      }
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "export-data") {
      void this.handleExport();
      return;
    }
    if (action === "import-data") {
      const input = this.el.querySelector<HTMLInputElement>("[data-import-input]");
      input?.click();
      return;
    }
    if (action === "wipe-data") {
      const isServer = capabilitiesSnapshot().portable;
      openConfirmModal({
        title: "Wipe Application Data?",
        messageHtml:
          "<p>Permanently erase all pilots, races, practice sessions, track gates, timers, and recorded laps, and restore application settings to defaults?</p>",
        warningHtml: isServer
          ? "All data stored in the server's slaprf.db database will be permanently cleared, leaving empty pilots, races, practices, and timers lists."
          : "All locally saved data in this browser will be permanently cleared, leaving empty pilots, races, practices, and timers lists.",
        confirmLabel: "Wipe Data",
        danger: true,
        onConfirm: async () => {
          await this.api.wipeApplicationData();
          this.announcer?.reloadPrefs();
          sharedMultiGPService.reloadPrefs();
          this.refreshStorage(true);
        },
      });
      return;
    }
    if (action === "restore-demo-data") {
      openConfirmModal({
        title: "Restore Demo Data?",
        messageHtml:
          "<p>Load sample Bay Area pilots, a 3-gate track, simulated timers, practice sessions, and showcase races into the active workspace?</p>",
        warningHtml:
          "Any current pilots, track gates, practice sessions, or unsaved active data in the current workspace will be replaced with the demo dataset.",
        confirmLabel: "Restore Demo Data",
        onConfirm: async () => {
          this.announcer?.wakeAudio();
          await this.api.restoreDemoData();
          if (this.announcer) {
            this.announcer.update({ enabled: true, qualifierLapCallouts: true });
          }
          sharedMultiGPService.reloadPrefs();
          this.refreshStorage(true);
          window.location.hash = buildPracticeHash("session", "open-track-practice");
        },
      });
    }
  };

  private async handleExport(): Promise<void> {
    const bundle = await this.api.exportApplicationData();
    const jsonStr = JSON.stringify(bundle, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `slaprf-app-data-${stamp}.json`;
    downloadTextFile(filename, "application/json", jsonStr);
    recordBackupNow();
    this.refreshStorage(true);
  }

  private async handleImportFile(file: File): Promise<void> {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    await this.api.importApplicationData(parsed);
    this.announcer?.reloadPrefs();
    sharedMultiGPService.reloadPrefs();
    this.refreshStorage(true);
  }

  private render(): void {
    const isServer = capabilitiesSnapshot().portable;
    this.el.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Backup application data</div>
            <div class="option-sub">${
              isServer
                ? `Pilots, track, timers, rules, and laps are saved automatically in the server's embedded <span class="mono">slaprf.db</span> database. Download a JSON backup anytime to archive or transfer events.`
                : `Pilots, track, timers, rules, and laps in Demo Mode are saved in this browser. Download a JSON backup to transfer them into a SlapRF Server.`
            }</div>
            <div class="option-sub storage-status" data-storage-status></div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-sm" data-action="export-data">Download</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Restore application data</div>
            <div class="option-sub">Restore settings, pilots, track layout, timers, and recorded laps from a saved JSON backup.</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-sm" data-action="import-data">Upload</button>
            <input type="file" accept=".json,application/json" data-import-input hidden />
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Wipe application data</div>
            <div class="option-sub">${
              isServer
                ? `Clears all pilots, races, practice sessions, track gates, timers, and laps in <span class="mono">slaprf.db</span> and restores settings to defaults.`
                : `Clears all pilots, races, practice sessions, track gates, timers, and laps in this browser and restores settings to defaults.`
            }</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-sm" data-action="wipe-data">Wipe data</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Demo data</div>
            <div class="option-sub">Load sample Bay Area pilots, a 4-gate track, simulated timers, and an Open Practice session to explore or test the app.</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-sm" data-action="restore-demo-data">Restore</button>
          </div>
        </div>
      </div>`;
    this.renderStatus();
  }
}

/** Authentication section: configure Basic Auth (enabled toggle + username & password). */
export class AuthenticationSettingsCard extends Component {
  private enabled = false;
  private savedEnabled = false;
  private username = "";
  private password = "";
  private hasSavedPassword = false;
  private revealPassword = false;
  private busy = false;
  private statusMsg = "";
  private errorMsg = "";

  constructor(el: HTMLElement) {
    super(el);
    if (cachedAuthConfig) {
      this.enabled = cachedAuthConfig.enabled;
      this.savedEnabled = cachedAuthConfig.enabled;
      this.username = cachedAuthConfig.username;
      this.hasSavedPassword = cachedAuthConfig.hasPassword;
      this.password = cachedAuthConfig.password || "";
    }
    el.addEventListener("change", this.handleChange);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(
      subscribeCapabilities(() => {
        void this.loadConfig();
      })
    );
    this.render();
    void this.loadConfig();
  }

  public async loadConfig(): Promise<void> {
    const caps = capabilitiesSnapshot();
    if (caps.portable) {
      try {
        const cfg = await fetchServerAuthConfig(caps.backendBaseUrl);
        cachedAuthConfig = cfg;
        this.enabled = cfg.enabled;
        this.savedEnabled = cfg.enabled;
        this.username = cfg.username;
        this.hasSavedPassword = cfg.hasPassword;
        this.password = cfg.password || "";
      } catch {
        // Keep current fields if unreachable
      }
    } else {
      const cfg = getDemoAuthConfig();
      cachedAuthConfig = cfg;
      this.enabled = cfg.enabled;
      this.savedEnabled = cfg.enabled;
      this.username = cfg.username;
      this.hasSavedPassword = cfg.hasPassword;
      this.password = cfg.password || "";
    }
    this.render();
  }

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.name === "auth-username") {
      this.username = target.value;
      this.errorMsg = "";
      this.statusMsg = "";
    } else if (target.name === "auth-password") {
      this.password = target.value;
      this.errorMsg = "";
      this.statusMsg = "";
    }
  };

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.name === "auth-enabled") {
      this.enabled = target.checked;
      this.errorMsg = "";
      this.statusMsg = "";
      if (!this.enabled && this.savedEnabled) {
        void this.disableAuthNow();
        return;
      }
      if (this.enabled && !this.password) {
        this.password = "SlapRF";
      }
      this.render();
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "clear-remembered-auth") {
      clearRememberedAuthCredentials();
      clearActiveAuthSession();
      window.location.reload();
      return;
    }
    if (action === "toggle-auth-reveal") {
      this.revealPassword = !this.revealPassword;
      this.render();
      return;
    }
    if (action === "save-auth") {
      void this.saveAuth();
    }
  };

  private async disableAuthNow(): Promise<void> {
    const caps = capabilitiesSnapshot();
    this.busy = true;
    this.render();
    try {
      if (caps.portable) {
        const res = await saveServerAuthConfig(
          { enabled: false, username: this.username },
          caps.backendBaseUrl
        );
        if (!res.ok) {
          this.errorMsg = res.error || "Failed to disable authentication.";
          this.enabled = true;
          return;
        }
        this.savedEnabled = false;
        this.hasSavedPassword = res.status.hasPassword;
      } else {
        const res = saveDemoAuthConfig({ enabled: false, username: this.username });
        if (!res.ok) {
          this.errorMsg = res.error || "Failed to disable authentication.";
          this.enabled = true;
          return;
        }
        this.savedEnabled = false;
        this.hasSavedPassword = res.status.hasPassword;
      }
      clearActiveAuthSession();
      this.statusMsg = "Basic authentication disabled.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async saveAuth(): Promise<void> {
    const cleanUser = this.username.trim();
    const cleanPass = this.password;
    if (this.enabled && !cleanUser) {
      this.errorMsg = "Enter a username.";
      this.render();
      return;
    }
    if (this.enabled && !cleanPass && !this.hasSavedPassword) {
      this.errorMsg = "Enter a password.";
      this.render();
      return;
    }

    const caps = capabilitiesSnapshot();
    this.busy = true;
    this.errorMsg = "";
    this.statusMsg = "";
    this.render();

    try {
      if (caps.portable) {
        const res = await saveServerAuthConfig(
          {
            enabled: this.enabled,
            username: cleanUser,
            password: cleanPass,
          },
          caps.backendBaseUrl
        );
        if (!res.ok) {
          this.errorMsg = res.error || "Failed to save authentication settings.";
          return;
        }
        this.savedEnabled = res.status.enabled;
        this.username = res.status.username;
        this.hasSavedPassword = res.status.hasPassword;
        this.password = "";
      } else {
        const res = saveDemoAuthConfig({
          enabled: this.enabled,
          username: cleanUser,
          password: cleanPass,
        });
        if (!res.ok) {
          this.errorMsg = res.error || "Failed to save authentication settings.";
          return;
        }
        this.savedEnabled = res.status.enabled;
        this.username = res.status.username;
        this.hasSavedPassword = res.status.hasPassword;
        this.password = "";
      }

      if (this.savedEnabled) {
        clearActiveAuthSession();
        window.location.reload();
        return;
      }
      this.statusMsg = "Authentication settings saved.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    const caps = capabilitiesSnapshot();
    const isServer = caps.portable;
    const remembered = getRememberedAuthCredentials(isServer ? "server" : "demo", caps.backendBaseUrl ?? "");
    const eyeLabel = this.revealPassword ? "Hide password" : "Reveal password";
    const passPlaceholder = this.hasSavedPassword ? "••••••••" : "Enter password";

    this.el.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Basic authentication</div>
            <div class="option-sub">${
              isServer
                ? "Require a username and password at the SlapRF Server level before accessing the application."
                : "Require a username and password on the boot screen before accessing Demo Mode in this browser."
            }</div>
            ${this.statusMsg ? `<div class="option-sub" style="margin-top:6px;color:var(--text)">${esc(this.statusMsg)}</div>` : ""}
            ${this.errorMsg ? `<div class="storage-status-error" style="margin-top:6px">${esc(this.errorMsg)}</div>` : ""}
          </div>
          <div class="option-actions">
            <label class="switch switch-lg">
              <input type="checkbox" name="auth-enabled" data-auth-toggle ${this.enabled ? "checked" : ""} ${this.busy ? "disabled" : ""} />
              <span></span>
            </label>
          </div>
        </div>
        ${
          this.enabled
            ? `<div class="option-row" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);align-items:flex-end;flex-wrap:wrap;gap:12px">
                <div style="display:flex;gap:10px;flex-wrap:wrap;flex:1;min-width:240px">
                  <label class="field" style="flex:1;min-width:140px;margin:0">
                    <span class="field-label" style="text-transform:none;letter-spacing:0.01em">Username</span>
                    <input
                      type="text"
                      name="auth-username"
                      data-auth-username
                      class="input"
                      placeholder="Enter username"
                      value="${esc(this.username)}"
                      autocomplete="username"
                      spellcheck="false"
                    />
                  </label>
                  <label class="field" style="flex:1;min-width:160px;margin:0">
                    <span class="field-label" style="text-transform:none;letter-spacing:0.01em">Password</span>
                    <div class="flasher-pass-wrap" style="width:100%">
                      <input
                        type="${this.revealPassword ? "text" : "password"}"
                        name="auth-password"
                        data-auth-password
                        class="input flasher-pass-input"
                        placeholder="${esc(passPlaceholder)}"
                        value="${esc(this.password)}"
                        autocomplete="new-password"
                      />
                      <button
                        type="button"
                        class="flasher-pass-toggle"
                        data-action="toggle-auth-reveal"
                        aria-label="${eyeLabel}"
                        title="${eyeLabel}"
                      >
                        ${this.revealPassword ? icons.eyeOff(15) : icons.eye(15)}
                      </button>
                    </div>
                  </label>
                </div>
                <div class="option-actions">
                  <button type="button" class="btn btn-armed btn-sm" data-action="save-auth" ${this.busy ? "disabled" : ""}>
                    ${this.busy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>`
            : ""
        }
      </div>
      ${
        remembered
          ? `<div class="card" data-auth-remembered-card>
              <div class="option-row">
                <div>
                  <div class="option-title">Browser saved credentials</div>
                  <div class="option-sub">Credentials for <span class="mono">${esc(remembered.username)}</span> are saved in this browser for automatic sign-in across reloads.</div>
                </div>
                <div class="option-actions">
                  <button type="button" class="btn btn-sm" data-action="clear-remembered-auth">Clear credentials</button>
                </div>
              </div>
            </div>`
          : ""
      }`;
  }
}
