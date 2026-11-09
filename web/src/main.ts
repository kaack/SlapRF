import { installCustomSelects } from "./core/custom_select";
import { Router } from "./core/router";
import { installSettingsIntroCollapse } from "./core/settings_intro";
import { installTableScrollIndicators } from "./core/table_scroll";
import { installWakeLock } from "./core/wake_lock";
import { AppShell } from "./layout/AppShell";
import { Announcer } from "./services/announcer";
import { ApiClient } from "./services/api_client";
import { AppStore } from "./state/store";

const MIN_BOOT_LOADER_MS = 2200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setBootStatus(detail: string, pct?: number): void {
  const statusEl = document.getElementById("slaprf-boot-status");
  if (statusEl) statusEl.textContent = detail;
  if (pct !== undefined) {
    const fillEl = document.getElementById("slaprf-boot-fill");
    if (fillEl) fillEl.style.width = `${Math.max(5, Math.min(100, pct))}%`;
  }
}

function dismissBootLoader(): void {
  const loader = document.getElementById("slaprf-boot-loader");
  if (!loader) return;
  loader.classList.add("is-ready");
  window.setTimeout(() => loader.remove(), 550);
}

async function bootstrap(): Promise<void> {
  const bootStartMs = performance.now();
  window.__slaprfBootStatus = setBootStatus;

  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");

  setBootStatus("Initializing UI components…", 18);
  installCustomSelects();
  installTableScrollIndicators();
  installSettingsIntroCollapse();
  installWakeLock();

  const store = new AppStore();
  const api = new ApiClient(store);
  const router = new Router();
  // Lives for the whole app so lap calls happen whichever view is open.
  const announcer = new Announcer(store);

  new AppShell(root, store, api, router, announcer);
  await api.initialize();

  // Keep the radar boot sequence visible long enough to enjoy even on fast local/cached loads
  const elapsedMs = performance.now() - bootStartMs;
  const remainingMs = Math.max(0, MIN_BOOT_LOADER_MS - elapsedMs);
  if (remainingMs > 0) {
    const stepMs = remainingMs / 3;
    setBootStatus("Calibrating 5.8 GHz Raceband R1–R8 channels…", 86);
    await sleep(stepMs);
    setBootStatus("Synchronizing Hub + Spoke gate telemetry…", 94);
    await sleep(stepMs);
    setBootStatus("Track armed · Ready", 100);
    await sleep(stepMs);
  } else {
    setBootStatus("Track armed · Ready", 100);
    await sleep(260);
  }

  dismissBootLoader();
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((err) => {
    console.error("Gate Timer failed to start:", err);
    setBootStatus(`Startup error: ${err instanceof Error ? err.message : String(err)}`, 100);
    window.setTimeout(() => dismissBootLoader(), 1500);
  });
});
