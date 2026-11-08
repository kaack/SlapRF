import { installCustomSelects } from "./core/custom_select";
import { Router } from "./core/router";
import { installTableScrollIndicators } from "./core/table_scroll";
import { AppShell } from "./layout/AppShell";
import { Announcer } from "./services/announcer";
import { ApiClient } from "./services/api_client";
import { AppStore } from "./state/store";

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
  setBootStatus("Ready", 100);
  loader.classList.add("is-ready");
  window.setTimeout(() => loader.remove(), 350);
}

async function bootstrap(): Promise<void> {
  window.__slaprfBootStatus = setBootStatus;

  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");

  setBootStatus("Initializing UI components…", 16);
  installCustomSelects();
  installTableScrollIndicators();

  const store = new AppStore();
  const api = new ApiClient(store);
  const router = new Router();
  // Lives for the whole app so lap calls happen whichever view is open.
  const announcer = new Announcer(store);

  new AppShell(root, store, api, router, announcer);
  await api.initialize();
  dismissBootLoader();
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((err) => {
    console.error("Gate Timer failed to start:", err);
    setBootStatus(`Startup error: ${err instanceof Error ? err.message : String(err)}`, 100);
    window.setTimeout(() => dismissBootLoader(), 1500);
  });
});
