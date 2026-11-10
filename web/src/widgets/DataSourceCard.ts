import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { enginePersistence, formatBytes, getLastBackupAt, recordBackupNow } from "../services/engine_persistence";
import { getStorageStatus, StorageStatus } from "../services/offline";
import { AppStore } from "../state/store";

function fmtWhen(ms: number | null): string {
  if (!ms) return "never";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

/** Toggle between the built-in track simulator and real-world physical XIAO hardware (USB-C Hub), both timed by the in-browser WASM engine. */
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
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Simulation active</div>
            <div class="option-sub">Runs simulated pilots, timers, and 6S flight packs in a separate dataset. Turn off to time laps with your physical USB-C Hub on the <a href="#/network" class="link-inline">Network</a> page.</div>
          </div>
          <div class="option-actions">
            <label class="switch switch-lg">
              <input type="checkbox" name="simulator" ${sim ? "checked" : ""} />
              <span></span>
            </label>
          </div>
        </div>
      </div>`;
  }
}

/** Persistence section: storage status + Export backup, Import, and Wipe application data sub-cards. */
export class PersistenceSettings extends Component {
  private readonly api: ApiClient;
  private readonly announcer?: Announcer;
  private storage: StorageStatus | null = null;
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
    const tick = window.setInterval(() => this.renderStatus(), 15_000);
    this.onDispose(() => window.clearInterval(tick));
    this.render();
    this.refreshStorage(true);
  }

  /** Re-reads persisted/usage/quota (throttled; `estimate()` is async but not free). */
  private refreshStorage(force: boolean): void {
    this.renderStatus();
    if (!force && performance.now() - this.storageFetchedAt < 5000) return;
    this.storageFetchedAt = performance.now();
    void getStorageStatus().then((s) => {
      this.storage = s;
      this.renderStatus();
    });
  }

  private renderStatus(): void {
    const host = this.el.querySelector<HTMLElement>("[data-storage-status]");
    if (!host) return;
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
    recordBackupNow();
    this.refreshStorage(true);
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
            <div class="option-title">Saved data &amp; backup</div>
            <div class="option-sub">Pilots, track, timers, rules, and laps are saved automatically in this browser. Export a JSON backup regularly, as browser storage can be cleared.</div>
            <div class="option-sub storage-status" data-storage-status></div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="export-data">
              ${icons.download(14)}<span>Export backup</span>
            </button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Import application data</div>
            <div class="option-sub">Restore settings, pilots, track layout, timers, and recorded laps from a saved JSON backup.</div>
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
            <div class="option-sub">Clears all saved data in this browser and resets settings, pilots, track, and laps to system defaults.</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="wipe-data">
              ${icons.trash(14)}<span>Wipe application data</span>
            </button>
          </div>
        </div>
      </div>`;
    this.renderStatus();
  }
}
