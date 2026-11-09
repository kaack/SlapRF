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
    const usingBrowser = this.api.usingBrowserRealEngine;
    const desktopAvail = this.api.desktopServerAvailable;

    const activeRuntimeLabel = sim
      ? "Simulator (in-browser WASM)"
      : usingBrowser
        ? "Browser engine (WASM direct to Hub)"
        : "Desktop Go server (Hub SSE + LiveTime TCP :5403 + SQLite)";

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
              <div class="option-sub">Run the 5.8 GHz DSP &amp; lap timing engine right in the browser via WebAssembly (streams directly from the Hub over Wi-Fi SSE or USB-C on the <a href="#/network" class="link-inline">Network</a> page), or use the desktop app for MultiGP LiveTime TCP (:5403) and SQLite storage.</div>
            </div>
            <div class="option-actions">
              <div class="segmented" role="group" aria-label="Hardware timing runtime">
                <button type="button" class="${mode === "auto" ? "is-active" : ""}" data-action="engine-mode" data-mode="auto" title="${desktopAvail ? "Desktop server detected (uses Desktop app)" : "Static web host detected (uses Browser WASM)"}">Auto</button>
                <button type="button" class="${mode === "browser" ? "is-active" : ""}" data-action="engine-mode" data-mode="browser">Browser (WASM)</button>
                <button type="button" class="${mode === "desktop" ? "is-active" : ""}" data-action="engine-mode" data-mode="desktop">Desktop app</button>
              </div>
            </div>
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
