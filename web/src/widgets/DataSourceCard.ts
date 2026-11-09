import { Component } from "../core/component";
import { icons } from "../core/icons";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

/** Toggle between real-world physical XIAO hardware and the built-in track simulator. */
export class DataSourceCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("change", this.handleChange);
    this.onDispose(() => el.removeEventListener("change", this.handleChange));
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.render();
  }

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.name === "simulator") {
      void this.api.toggleSimulator();
    }
  };

  private render(): void {
    const sim = this.store.simulatorRunning;
    this.el.innerHTML = `
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
