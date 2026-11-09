import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { RealEngineMode } from "../services/browser_hub_bridge";
import { sharedTimerConsole } from "../services/timer_console";
import { AppStore } from "../state/store";

/** Toggle between real-world physical XIAO hardware, the browser WASM Hub bridge, and the built-in track simulator. */
export class DataSourceCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("change", this.handleChange);
    el.addEventListener("click", this.handleClick);
    el.addEventListener("keydown", this.handleKeyDown);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("keydown", this.handleKeyDown);
    });
    this.onDispose(
      store.subscribe(["status"], () => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.name === "hubHost" && this.el.contains(active)) {
          return;
        }
        this.render();
      })
    );
    this.onDispose(
      api.hubBridge.subscribe(() => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.name === "hubHost" && this.el.contains(active)) {
          return;
        }
        this.render();
      })
    );
    this.render();
  }

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.name === "simulator") {
      void this.api.toggleSimulator();
      return;
    }
    if (target.name === "hubHost") {
      this.api.hubBridge.setHubHost(target.value, true);
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLInputElement;
    if (target.name === "hubHost" && e.key === "Enter") {
      e.preventDefault();
      this.api.hubBridge.setHubHost(target.value, true);
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === "engine-mode") {
      const mode = btn.dataset.mode as RealEngineMode | undefined;
      if (mode === "auto" || mode === "browser" || mode === "desktop") {
        void this.api.setRealEngineMode(mode).then(() => this.render());
      }
      return;
    }
    if (action === "discover-hub") {
      const input = this.el.querySelector<HTMLInputElement>('input[name="hubHost"]');
      if (input && input.value.trim()) {
        this.api.hubBridge.setHubHost(input.value, false);
      }
      void this.api.hubBridge.discoverHub();
      return;
    }
    if (action === "connect-hub") {
      const input = this.el.querySelector<HTMLInputElement>('input[name="hubHost"]');
      this.api.hubBridge.setHubHost(input ? input.value : this.api.hubBridge.hubHost, true);
      if (this.api.usingBrowserRealEngine) {
        this.api.hubBridge.connectWifiStream();
      }
      return;
    }
    if (action === "reset-hub-host") {
      this.api.hubBridge.setHubHost("192.168.4.1", true);
      return;
    }
    if (action === "restore-hub-defaults") {
      this.api.hubBridge.resetDefaults();
      void this.api.setRealEngineMode("auto").then(() => this.render());
    }
  };

  private render(): void {
    const sim = this.store.simulatorRunning;
    const mode = this.api.realEngineMode;
    const hub = this.api.hubBridge;
    const usingBrowser = this.api.usingBrowserRealEngine;
    const desktopAvail = this.api.desktopServerAvailable;
    const usbConnected = sharedTimerConsole.connected;
    const isCustomHost = hub.hubHost !== "192.168.4.1";

    let wifiBadge = `<span class="note">Standby (enable Browser engine &amp; turn off simulation)</span>`;
    if (usingBrowser) {
      if (hub.wifiState === "connected") {
        wifiBadge = `<span class="note" style="color:var(--ok,#4dff88);">Connected to http://${esc(hub.hubHost)}/api/hub-stream · ${hub.wifiFramesRx.toLocaleString()} frames</span>`;
      } else if (hub.wifiState === "connecting") {
        wifiBadge = `<span class="note">Connecting to http://${esc(hub.hubHost)}/api/hub-stream…</span>`;
      } else if (hub.wifiError) {
        wifiBadge = `<span class="note">${esc(hub.wifiError)}</span>`;
      } else {
        wifiBadge = `<span class="note">Ready · http://${esc(hub.hubHost)}/api/hub-stream</span>`;
      }
    }

    const usbBadge = usbConnected
      ? `<span class="note" style="color:var(--ok,#4dff88);">USB-C WebSerial connected · ${hub.usbFramesRx.toLocaleString()} frames</span>`
      : `<span class="note">USB-C WebSerial idle (use Connect in top bar for zero-config USB bridge)</span>`;

    const activeRuntimeLabel = sim
      ? "Simulator (in-browser WASM)"
      : usingBrowser
        ? "Browser engine (WASM direct to Hub)"
        : "Desktop Go server (UDP :5404 + SQLite)";

    this.el.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Simulation active</div>
            <div class="option-sub">Feeds the app with simulated pilots, gates, and 6S flight packs in a separate dataset. Turn off to use your physical timers.</div>
          </div>
          <div class="option-actions">
            <label class="switch switch-lg">
              <input type="checkbox" name="simulator" ${sim ? "checked" : ""} />
              <span></span>
            </label>
          </div>
        </div>
      </div>

      <div class="card card-flush">
        <div class="card-body">
          <div class="option-row">
            <div>
              <div class="option-title">Hardware timing runtime</div>
              <div class="option-sub">Run the 5.8 GHz DSP &amp; lap timing engine right in the browser via WebAssembly (connects directly from the browser to the Hub over Wi-Fi or USB-C with no app download), or use the desktop app for raw UDP and SQLite storage.</div>
            </div>
            <div class="option-actions">
              <div class="segmented" role="group" aria-label="Hardware timing runtime">
                <button type="button" class="seg ${mode === "auto" ? "is-active" : ""}" data-action="engine-mode" data-mode="auto" title="${desktopAvail ? "Desktop server detected (uses Desktop app)" : "Static web host detected (uses Browser WASM)"}">Auto</button>
                <button type="button" class="seg ${mode === "browser" ? "is-active" : ""}" data-action="engine-mode" data-mode="browser">Browser (WASM)</button>
                <button type="button" class="seg ${mode === "desktop" ? "is-active" : ""}" data-action="engine-mode" data-mode="desktop">Desktop app</button>
              </div>
            </div>
          </div>

          <div class="form-grid" style="margin-top:8px;">
            <label class="field">
              <span>Hub Wi-Fi address (AP default <code>192.168.4.1</code> or LAN IP)</span>
              <div class="check-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <div class="flasher-pass-wrap has-inline-action" style="flex:1 1 190px;max-width:260px;">
                  <input
                    class="input mono ${isCustomHost ? "flasher-pass-input" : ""}"
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
                <button type="button" class="btn btn-sm btn-ghost" data-action="discover-hub" ${hub.discovering ? "disabled" : ""}>
                  ${hub.discovering ? "Scanning…" : "Discover Hub"}
                </button>
                <button type="button" class="btn btn-sm" data-action="connect-hub">
                  Connect Wi-Fi
                </button>
              </div>
            </label>
          </div>

          <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
            <div>${wifiBadge}</div>
            <div>${usbBadge}</div>
          </div>
        </div>
        <div class="rules-foot">
          <p class="note">Active runtime: <strong>${esc(activeRuntimeLabel)}</strong></p>
          <button class="btn btn-ghost btn-sm" type="button" data-action="restore-hub-defaults">Restore defaults</button>
        </div>
      </div>`;
  }
}

/** Persistence section with Export, Import, and Wipe application data sub-cards. */
export class PersistenceSettings extends Component {
  private readonly api: ApiClient;
  private readonly announcer?: Announcer;

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
    this.render();
  }

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.matches("[data-import-input]")) {
      const file = target.files?.[0];
      target.value = "";
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
      const msg =
        "Wipe all saved application data (pilots, track layout, timers, timing rules, announcer settings, recorded laps, and UI preferences) and restore system defaults?";
      if (!window.confirm(msg)) return;
      void (async () => {
        await this.api.wipeApplicationData();
        this.announcer?.reloadPrefs();
      })();
    }
  };

  private async handleExport(): Promise<void> {
    const bundle = await this.api.exportApplicationData();
    const jsonStr = JSON.stringify(bundle, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `slaprf-app-data-${stamp}.json`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async handleImportFile(file: File): Promise<void> {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    await this.api.importApplicationData(parsed);
    this.announcer?.reloadPrefs();
  }

  private render(): void {
    this.el.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Export application data</div>
            <div class="option-sub">Download a complete JSON snapshot of all application state (pilots, track layout, timers, timing rules, announcer settings, laps, and UI preferences).</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="export-data">
              ${icons.download(14)}<span>Export JSON</span>
            </button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Import application data</div>
            <div class="option-sub">Restore all application settings, pilots, track layout, timers, recorded laps, and UI preferences from a saved JSON snapshot.</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="import-data">
              ${icons.upload(14)}<span>Import JSON</span>
            </button>
            <input type="file" accept=".json,application/json" data-import-input hidden />
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Wipe application data</div>
            <div class="option-sub">Clears all saved application state across both browser storage and the local database, returning every setting, pilot, track layout, and session to clean system defaults.</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="wipe-data">
              ${icons.trash(14)}<span>Wipe application data</span>
            </button>
          </div>
        </div>
      </div>`;
  }
}
