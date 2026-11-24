import { downloadTextFile } from "../core/android_bridge";
import { Component } from "../core/component";
import { scanCustomSelects } from "../core/custom_select";
import { esc } from "../core/format";
import { ApiClient } from "../services/api_client";
import {
  capabilitiesSnapshot,
  resolveBackendUrl,
  subscribeCapabilities,
} from "../services/capabilities";
import { formatBytes } from "../services/engine_persistence";

export interface BackendLogStatus {
  logPath: string;
  sizeBytes: number;
  level: string;
  levels?: string[];
  lineCount: number;
  maxLines?: number;
}

const DEMO_LOG_LEVEL_STORAGE_KEY = "slaprf.demoLogLevel";

let cachedBackendLogStatus: BackendLogStatus | null = null;

/** Preloads `/v1/logs/config` alongside other Settings section statuses on startup. */
export function preloadDiagnosticsStatus(): void {
  if (!capabilitiesSnapshot().portable) return;
  void fetch(resolveBackendUrl("/v1/logs/config"), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
    .then(async (resp) => {
      if (!resp.ok) return;
      cachedBackendLogStatus = (await resp.json()) as BackendLogStatus;
    })
    .catch(() => undefined);
}

/**
 * Top-level Diagnostics settings component (`#/setup` -> `Diagnostics`), structured parallel to
 * `PersistenceSettings` with a dedicated `Log level` panel inside.
 */
export class DiagnosticsSettings extends Component {
  private readonly api: ApiClient;
  private backendLog: BackendLogStatus | null = cachedBackendLogStatus;
  private logFetchedAt = 0;
  private restoredDemoLevel = false;

  constructor(el: HTMLElement, api: ApiClient) {
    super(el);
    this.api = api;
    el.addEventListener("change", this.handleChange);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(
      subscribeCapabilities(() => {
        this.render();
        this.refreshLogs(true);
      })
    );
    const tick = window.setInterval(() => this.refreshLogs(true), 8_000);
    this.onDispose(() => window.clearInterval(tick));
    this.render();
    this.refreshLogs(true);
  }

  private refreshLogs(force: boolean): void {
    this.renderLogStatus();
    if (typeof this.api?.getLogsConfig !== "function") return;
    if (!force && performance.now() - this.logFetchedAt < 4000) return;
    this.logFetchedAt = performance.now();

    if (!capabilitiesSnapshot().portable && !this.restoredDemoLevel) {
      this.restoredDemoLevel = true;
      try {
        const saved = window.localStorage.getItem(DEMO_LOG_LEVEL_STORAGE_KEY);
        if (saved && saved !== "info") {
          void this.api
            .setLogLevel(saved)
            .then((st) => {
              this.backendLog = st;
              cachedBackendLogStatus = st;
              this.renderLogStatus();
            })
            .catch(() => undefined);
          return;
        }
      } catch {
        // Ignore storage errors
      }
    }

    void this.api
      .getLogsConfig()
      .then((st) => {
        this.backendLog = st;
        cachedBackendLogStatus = st;
        this.renderLogStatus();
      })
      .catch(() => undefined);
  }

  private renderLogStatus(): void {
    const host = this.el.querySelector<HTMLElement>("[data-log-status]");
    const sel = this.el.querySelector<HTMLSelectElement>("[data-log-level-select]");
    const lg = this.backendLog;
    if (sel && lg?.level) {
      const norm = lg.level.toLowerCase();
      if (sel.value !== norm) {
        sel.value = norm;
        sel.setAttribute("value", norm);
        scanCustomSelects(this.el);
      }
    }
    if (!host) return;
    const isServer = capabilitiesSnapshot().portable;
    if (!lg) {
      host.innerHTML = isServer
        ? `Level: <strong>INFO</strong> · file: <strong>slaprf.log</strong> · loading…`
        : `Level: <strong>INFO</strong> · in-memory buffer · loading…`;
      return;
    }
    const locationPart = lg.logPath
      ? `file: <span class="mono">${esc(lg.logPath)}</span>`
      : `in-memory (${lg.lineCount}${lg.maxLines ? ` / ${lg.maxLines}` : ""} lines)`;
    const parts = [
      `Level: <strong>${esc((lg.level || "info").toUpperCase())}</strong>`,
      locationPart,
      `size: ${formatBytes(lg.sizeBytes || 0)}`,
    ].filter(Boolean);
    host.innerHTML = parts.join(" · ");
  }

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.matches("[data-log-level-select]")) {
      const sel = target as HTMLSelectElement;
      void this.handleLogLevelChange(sel.value);
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "download-log") {
      void this.handleDownloadLog();
      return;
    }
    if (action === "clear-log") {
      void this.handleClearLog();
    }
  };

  private async handleLogLevelChange(level: string): Promise<void> {
    if (!capabilitiesSnapshot().portable) {
      try {
        window.localStorage.setItem(DEMO_LOG_LEVEL_STORAGE_KEY, level);
      } catch {
        // Ignore storage errors
      }
    }
    try {
      const st = await this.api.setLogLevel(level);
      this.backendLog = st;
      cachedBackendLogStatus = st;
      this.renderLogStatus();
    } catch {
      // Ignore transient errors
    }
  }

  private async handleDownloadLog(): Promise<void> {
    try {
      const text = await this.api.downloadLogsText();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadTextFile(`slaprf-${stamp}.log`, "text/plain", text);
    } catch {
      // Ignore transient errors
    }
  }

  private async handleClearLog(): Promise<void> {
    try {
      const st = await this.api.clearLogs();
      this.backendLog = st;
      cachedBackendLogStatus = st;
      this.renderLogStatus();
    } catch {
      // Ignore transient errors
    }
  }

  private render(): void {
    const isServer = capabilitiesSnapshot().portable;
    const curLvl = (this.backendLog?.level || "info").toLowerCase();
    this.el.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Log level</div>
            <div class="option-sub">${
              isServer
                ? `User actions, laps, crossings, and hardware link events are written to <span class="mono">slaprf.log</span> (simulated events tagged <span class="mono">[SIM]</span>). Switch to <span class="mono">DEBUG</span> or <span class="mono">TRACE</span> when troubleshooting.`
                : `User actions, laps, crossings, and simulated hardware events are recorded in an in-memory buffer. Switch to <span class="mono">DEBUG</span> or <span class="mono">TRACE</span> when troubleshooting.`
            }</div>
            <div class="option-sub storage-status" data-log-status></div>
          </div>
          <div class="option-actions diag-log-actions">
            <select class="input input-sm diag-log-select" data-log-level-select aria-label="Diagnostic log level">
              <option value="error"${curLvl === "error" ? " selected" : ""}>ERROR</option>
              <option value="warn"${curLvl === "warn" ? " selected" : ""}>WARN</option>
              <option value="info"${curLvl === "info" ? " selected" : ""}>INFO (default)</option>
              <option value="debug"${curLvl === "debug" ? " selected" : ""}>DEBUG</option>
              <option value="trace"${curLvl === "trace" ? " selected" : ""}>TRACE</option>
            </select>
            <button type="button" class="btn btn-sm" data-action="download-log">Download</button>
            <button type="button" class="btn btn-sm" data-action="clear-log">Clear</button>
          </div>
        </div>
      </div>`;
    scanCustomSelects(this.el);
    this.renderLogStatus();
  }
}
