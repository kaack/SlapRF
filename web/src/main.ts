import { installCustomSelects } from "./core/custom_select";
import { Router } from "./core/router";
import { installSettingsIntroCollapse } from "./core/settings_intro";
import { installTableScrollIndicators } from "./core/table_scroll";
import { installWakeLock } from "./core/wake_lock";
import { AppShell } from "./layout/AppShell";
import { Announcer } from "./services/announcer";
import { ApiClient } from "./services/api_client";
import { BrowserHubBridge } from "./services/browser_hub_bridge";
import { sharedLiveTimeRelay } from "./services/livetime_relay";
import { installOffline, isDevHost } from "./services/offline";
import { bindSimSerialStore } from "./services/sim_serial_port";
import { usbPool } from "./services/timer_console";
import { AppStore } from "./state/store";

interface SlaprfHMRState {
  store: AppStore;
  api: ApiClient;
  router: Router;
  announcer: Announcer;
  shell: AppShell;
  es?: EventSource;
  cssStamp?: number;
  tsStamp?: number;
}

type HMRWindow = Window & { __slaprfHMR?: SlaprfHMRState };

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

function hotReloadUI(hmr: SlaprfHMRState): void {
  const root = document.getElementById("app");
  if (!root) return;

  // Upgrade live singletons in-place so edited methods on Store / ApiClient / Router / Announcer
  // take effect immediately without losing USB WebSerial connections, WASM state, or lap history.
  Object.setPrototypeOf(hmr.store, AppStore.prototype);
  Object.setPrototypeOf(hmr.api, ApiClient.prototype);
  bindSimSerialStore(hmr.store);
  if (hmr.store.simulatorRunning && !usbPool.mainConsole.connected) {
    void (hmr.api as unknown as { autoConnectSimulatedHub?: () => Promise<void> }).autoConnectSimulatedHub?.();
  }
  if (!(hmr.api as unknown as { provisionedUsbKeys?: Set<string> }).provisionedUsbKeys) {
    (hmr.api as unknown as { provisionedUsbKeys: Set<string> }).provisionedUsbKeys = new Set<string>();
  }
  if (hmr.api.hubBridge) {
    Object.setPrototypeOf(hmr.api.hubBridge, BrowserHubBridge.prototype);
  }
  Object.setPrototypeOf(hmr.router, Router.prototype);
  Object.setPrototypeOf(hmr.announcer, Announcer.prototype);

  const prevScrollX = window.scrollX;
  const prevScrollY = window.scrollY;

  try {
    hmr.shell?.destroy();
  } catch (err) {
    console.warn("[HMR] Error destroying previous shell:", err);
  }
  usbPool.rebindSlots();
  hmr.router.clearListeners();
  hmr.shell = new AppShell(root, hmr.store, hmr.api, hmr.router, hmr.announcer);

  window.scrollTo({ left: prevScrollX, top: prevScrollY });
  console.info("[HMR] UI hot-reloaded (USB & state preserved)");
}

function installDevHotReload(hmr: SlaprfHMRState): void {
  if (!isDevHost() || typeof EventSource === "undefined" || hmr.es) return;

  const es = new EventSource("/__dev/events");
  hmr.es = es;

  es.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data) as { css?: number; ts?: number };
      if (typeof data.css === "number") {
        if (hmr.cssStamp !== undefined && hmr.cssStamp !== data.css) {
          document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
            const base = link.getAttribute("href")?.split("?")[0];
            if (base) link.href = `${base}?v=${data.css}`;
          });
          console.info("[HMR] Stylesheets hot-reloaded");
        }
        hmr.cssStamp = data.css;
      }
      if (typeof data.ts === "number") {
        if (hmr.tsStamp !== undefined && hmr.tsStamp !== data.ts) {
          hmr.tsStamp = data.ts;
          document.querySelectorAll('script[data-slaprf-hmr="1"]').forEach((s) => s.remove());
          const script = document.createElement("script");
          script.src = `/dist/app.js?v=${data.ts}`;
          script.dataset.slaprfHmr = "1";
          document.body.appendChild(script);
          return;
        }
        hmr.tsStamp = data.ts;
      }
    } catch {
      // Ignore malformed SSE payloads
    }
  });
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

  const shell = new AppShell(root, store, api, router, announcer);
  const hmr: SlaprfHMRState = { store, api, router, announcer, shell };
  (window as HMRWindow).__slaprfHMR = hmr;
  installDevHotReload(hmr);

  await api.initialize();
  // LiveTime (via slaprf-relay) needs the WASM engine, which is ready now. Refresh the polled
  // LapRF counters immediately whenever the link changes (TopBar locks the arm button on it).
  sharedLiveTimeRelay.subscribe(() => void api.pollStatusNow().catch(() => undefined));
  sharedLiveTimeRelay.start();

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

const existingHMR = (window as HMRWindow).__slaprfHMR;
if (existingHMR) {
  hotReloadUI(existingHMR);
} else {
  const start = () => {
    installOffline();
    bootstrap().catch((err) => {
      console.error("Gate Timer failed to start:", err);
      setBootStatus(`Startup error: ${err instanceof Error ? err.message : String(err)}`, 100);
      window.setTimeout(() => dismissBootLoader(), 1500);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
