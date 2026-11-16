import { installCustomSelects } from "./core/custom_select";
import { navigateToRouteSection, Router } from "./core/router";
import { installSettingsIntroCollapse } from "./core/settings_intro";
import { installTableScrollIndicators } from "./core/table_scroll";
import { getAppTheme, initAppTheme, setAppTheme, subscribeAppTheme } from "./core/theme";
import { installWakeLock } from "./core/wake_lock";
import { AppShell } from "./layout/AppShell";
import { Announcer } from "./services/announcer";
import { ApiClient } from "./services/api_client";
import {
  clearActiveAuthSession,
  clearRememberedAuthCredentials,
  decodeBasicToken,
  encodeBasicToken,
  getRememberedAuthCredentials,
  installAuthFetchInterceptor,
  isDemoAuthRequired,
  loginServerAuth,
  loginServerAuthWithToken,
  saveDemoAuthConfig,
  saveRememberedAuthCredentials,
  verifyDemoAuthLogin,
} from "./services/auth";
import {
  connectionLostSnapshot,
  probeCapabilities,
  RuntimeCapabilities,
  subscribeConnectionLost,
} from "./services/capabilities";
import { enginePersistence } from "./services/engine_persistence";
import { sharedLapRFLink } from "./services/laprf_hardware_link";
import { sharedLiveTimeRelay } from "./services/livetime_relay";
import { installOffline } from "./services/offline";
import { sharedRHLink } from "./services/rh_hardware_link";
import { installSlaprfCurlBridge } from "./services/test_curl";
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
  loader.classList.remove("is-conflict", "is-connection-lost", "is-auth-required");
  loader.classList.add("is-ready");
}

async function waitForBootAuthentication(caps: RuntimeCapabilities): Promise<void> {
  const serverNeedsAuth = Boolean(caps.portable && caps.authRequired && !caps.authenticated);
  const demoNeedsAuth = Boolean(!caps.portable && isDemoAuthRequired());
  if (!serverNeedsAuth && !demoNeedsAuth) {
    return;
  }

  const mode = serverNeedsAuth ? "server" : "demo";
  const baseUrl = caps.backendBaseUrl ?? "";
  const remembered = getRememberedAuthCredentials(mode, baseUrl);
  let rememberedFailed = false;
  if (remembered) {
    if (serverNeedsAuth) {
      const res = await loginServerAuthWithToken(remembered.token, baseUrl);
      if (res.ok) {
        return;
      }
      clearRememberedAuthCredentials();
      clearActiveAuthSession();
      rememberedFailed = true;
    } else {
      const decoded = decodeBasicToken(remembered.token);
      if (decoded && verifyDemoAuthLogin(decoded.username, decoded.password)) {
        return;
      }
      clearRememberedAuthCredentials();
      clearActiveAuthSession();
      rememberedFailed = true;
    }
  }

  return new Promise<void>((resolve) => {
    const loader = document.getElementById("slaprf-boot-loader");
    const form = document.getElementById("slaprf-boot-auth") as HTMLFormElement | null;
    const userIn = document.getElementById("slaprf-boot-auth-user") as HTMLInputElement | null;
    const passIn = document.getElementById("slaprf-boot-auth-pass") as HTMLInputElement | null;
    const rememberChk = document.getElementById("slaprf-boot-auth-remember") as HTMLInputElement | null;
    const errEl = document.getElementById("slaprf-boot-auth-error");
    const submitBtn = document.getElementById("slaprf-boot-auth-submit") as HTMLButtonElement | null;
    const demoDisableBtn = document.getElementById("slaprf-boot-auth-demo-disable") as HTMLButtonElement | null;
    const themeToggleBtn = document.getElementById("slaprf-boot-auth-theme") as HTMLButtonElement | null;

    if (!loader || !form || !userIn || !passIn) {
      resolve();
      return;
    }

    loader.classList.remove("is-ready", "is-conflict", "is-connection-lost");
    loader.classList.add("is-auth-required");
    if (rememberChk) {
      rememberChk.checked = true;
    }
    if (errEl) {
      if (rememberedFailed) {
        errEl.textContent = "Saved credentials are no longer valid. Please sign in.";
        errEl.classList.add("is-visible");
      } else {
        errEl.textContent = "";
        errEl.classList.remove("is-visible");
      }
    }
    if (demoDisableBtn) {
      demoDisableBtn.hidden = !(!serverNeedsAuth && demoNeedsAuth);
    }
    const syncThemeLabel = () => {
      if (!themeToggleBtn) return;
      themeToggleBtn.textContent = getAppTheme() === "light" ? "Dark theme" : "Light theme";
    };
    syncThemeLabel();
    const onThemeToggle = () => {
      const next = getAppTheme() === "light" ? "dark" : "light";
      setAppTheme(next);
      syncThemeLabel();
    };
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", onThemeToggle);
    }
    window.setTimeout(() => userIn.focus(), 40);

    let submitting = false;
    const showError = (msg: string) => {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.classList.add("is-visible");
    };

    const onSubmit = async (e: Event) => {
      e.preventDefault();
      if (submitting) return;
      const username = userIn.value.trim();
      const password = passIn.value;
      if (!username || !password) {
        showError("Enter both username and password.");
        return;
      }

      submitting = true;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Signing in…";
      }
      if (errEl) {
        errEl.textContent = "";
        errEl.classList.remove("is-visible");
      }

      try {
        if (serverNeedsAuth) {
          const res = await loginServerAuth(username, password, caps.backendBaseUrl);
          if (!res.ok) {
            showError(res.error || "Invalid username or password.");
            passIn.value = "";
            passIn.focus();
            return;
          }
        } else {
          const ok = verifyDemoAuthLogin(username, password);
          if (!ok) {
            showError("Invalid username or password.");
            passIn.value = "";
            passIn.focus();
            return;
          }
        }

        if (rememberChk?.checked) {
          saveRememberedAuthCredentials({
            mode,
            backendBaseUrl: baseUrl,
            username,
            token: encodeBasicToken(username, password),
          });
        } else {
          clearRememberedAuthCredentials();
        }

        form.removeEventListener("submit", onSubmit);
        if (demoDisableBtn) {
          demoDisableBtn.removeEventListener("click", onDemoDisable);
          demoDisableBtn.hidden = true;
        }
        if (themeToggleBtn) {
          themeToggleBtn.removeEventListener("click", onThemeToggle);
        }
        loader.classList.remove("is-auth-required");
        resolve();
      } finally {
        submitting = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign In";
        }
      }
    };

    const onDemoDisable = () => {
      if (serverNeedsAuth) return;
      saveDemoAuthConfig({ enabled: false, username: "", password: "" });
      clearRememberedAuthCredentials();
      clearActiveAuthSession();
      form.removeEventListener("submit", onSubmit);
      if (demoDisableBtn) {
        demoDisableBtn.removeEventListener("click", onDemoDisable);
        demoDisableBtn.hidden = true;
      }
      if (themeToggleBtn) {
        themeToggleBtn.removeEventListener("click", onThemeToggle);
      }
      loader.classList.remove("is-auth-required");
      resolve();
    };

    form.addEventListener("submit", onSubmit);
    if (!serverNeedsAuth && demoNeedsAuth && demoDisableBtn) {
      demoDisableBtn.addEventListener("click", onDemoDisable);
    }
  });
}

function showBootConflictScreen(title: string, desc: string): HTMLElement | null {
  const loader = document.getElementById("slaprf-boot-loader");
  if (!loader) return null;
  const titleEl = document.getElementById("slaprf-boot-conflict-title");
  const descEl = document.getElementById("slaprf-boot-conflict-desc");
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = desc;
  loader.classList.remove("is-ready", "is-connection-lost");
  loader.classList.add("is-conflict");
  return document.getElementById("slaprf-boot-takeover-btn");
}

function bindConnectionLostOverlay(api: ApiClient): {
  show: (serverUrl: string) => void;
  hide: () => void;
} {
  let activeServerUrl = "";
  let reconnecting = false;

  const show = (serverUrl: string) => {
    activeServerUrl = serverUrl;
    const loader = document.getElementById("slaprf-boot-loader");
    if (!loader) return;
    const titleEl = document.getElementById("slaprf-boot-conflict-title");
    const descEl = document.getElementById("slaprf-boot-conflict-desc");
    const reconnectBtn = document.getElementById("slaprf-boot-reconnect-btn") as HTMLButtonElement | null;
    if (titleEl) titleEl.textContent = "Connection to SlapRF Server lost";
    if (descEl) {
      descEl.textContent = `Unable to reach the SlapRF Server (${serverUrl}). Make sure the server is running, then try reconnecting or go to Settings.`;
    }
    if (reconnectBtn && !reconnecting) {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = "Try Reconnecting";
    }
    loader.classList.remove("is-ready");
    loader.classList.add("is-conflict", "is-connection-lost");
  };

  const hide = () => {
    const loader = document.getElementById("slaprf-boot-loader");
    if (!loader || !loader.classList.contains("is-connection-lost")) return;
    dismissBootLoader();
  };

  const reconnectBtn = document.getElementById("slaprf-boot-reconnect-btn") as HTMLButtonElement | null;
  const settingsBtn = document.getElementById("slaprf-boot-settings-btn") as HTMLButtonElement | null;

  reconnectBtn?.addEventListener("click", () => {
    if (reconnecting) return;
    reconnecting = true;
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = "Reconnecting…";
    void api
      .reconnectBackendNow(activeServerUrl)
      .then((ok) => {
        if (ok) {
          hide();
          return;
        }
        const descEl = document.getElementById("slaprf-boot-conflict-desc");
        if (descEl) {
          descEl.textContent = `Still unable to reach ${activeServerUrl}. Check that the SlapRF Server is running and try again, or go to Settings.`;
        }
      })
      .finally(() => {
        reconnecting = false;
        if (reconnectBtn) {
          reconnectBtn.disabled = false;
          reconnectBtn.textContent = "Try Reconnecting";
        }
      });
  });

  settingsBtn?.addEventListener("click", () => {
    api.enterDisconnectedSettingsFromOutage();
    hide();
    navigateToRouteSection("setup", "datasource");
  });

  subscribeConnectionLost((state) => {
    if (state.lost) {
      show(state.serverUrl);
    } else {
      hide();
    }
  });

  return { show, hide };
}

async function bootstrap(): Promise<void> {
  let bootStartMs = performance.now();
  window.__slaprfBootStatus = setBootStatus;

  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");
  root.hidden = true;

  let displacedCleanup: (() => void) | null = null;

  setBootStatus("Detecting SlapRF engine…", 12);
  installAuthFetchInterceptor();
  const caps = await probeCapabilities();
  await waitForBootAuthentication(caps);
  bootStartMs = performance.now();

  if (!caps.portable) {
    await enginePersistence.ensureExclusiveTabOwnership({
      waitForUserTakeover: (trySilentAcquire) =>
        new Promise<"takeover" | "silent">((resolve) => {
          const btn = showBootConflictScreen(
            "SlapRF is already open in another tab",
            "Navigate to your open SlapRF tab to continue, or continue in this tab — the other tab will be switched to this screen."
          );

          let settled = false;
          const finish = (kind: "takeover" | "silent") => {
            if (settled) return;
            settled = true;
            btn?.removeEventListener("click", onTakeoverClick);
            document.removeEventListener("visibilitychange", onVisCheck);
            const loader = document.getElementById("slaprf-boot-loader");
            loader?.classList.remove("is-conflict");
            bootStartMs = performance.now();
            setBootStatus("Transferring active session to this tab…", 16);
            resolve(kind);
          };

          const onTakeoverClick = () => finish("takeover");
          const onVisCheck = () => {
            if (document.visibilityState !== "visible") return;
            window.setTimeout(() => {
              if (settled) return;
              void trySilentAcquire().then((acquired) => {
                if (acquired) finish("silent");
              });
            }, 550);
          };

          btn?.addEventListener("click", onTakeoverClick);
          document.addEventListener("visibilitychange", onVisCheck);
        }),
      onDisplaced: () => {
        displacedCleanup?.();
        root.hidden = true;
        root.innerHTML = "";
        try {
          window.slaprfWasm?.setRunning(false);
        } catch {
          /* ignore */
        }
        const btn = showBootConflictScreen(
          "Session moved to another SlapRF tab",
          "SlapRF is now active in another tab. Switch to that tab to continue, or continue here to disable the other tab."
        );
        if (btn) {
          const onReclaim = () => {
            btn.removeEventListener("click", onReclaim);
            const loader = document.getElementById("slaprf-boot-loader");
            loader?.classList.remove("is-conflict");
            setBootStatus("Reclaiming active session…", 20);
            void enginePersistence.requestTakeoverBroadcast().finally(() => {
              window.location.reload();
            });
          };
          btn.addEventListener("click", onReclaim);
        }
      },
    });
  }

  root.hidden = false;
  setBootStatus("Initializing UI components…", 18);
  installCustomSelects();
  installTableScrollIndicators();
  installSettingsIntroCollapse();
  installWakeLock();

  const store = new AppStore();
  subscribeAppTheme(() => store.notifyThemeChanged());
  const api = new ApiClient(store);
  installSlaprfCurlBridge(api);
  const router = new Router();
  // Lives for the whole app so lap calls happen whichever view is open.
  const announcer = new Announcer(store);
  displacedCleanup = () => {
    try {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  };

  new AppShell(root, store, api, router, announcer);
  const connLostOverlay = bindConnectionLostOverlay(api);

  await api.initialize();
  // LiveTime (via slaprf-relay) needs the WASM engine, which is ready now. Refresh the polled
  // LapRF counters immediately whenever the link changes (TopBar locks the arm button on it).
  sharedLiveTimeRelay.subscribe(() => void api.pollStatusNow().catch(() => undefined));
  sharedLapRFLink.subscribe(() => void api.pollStatusNow().catch(() => undefined));
  sharedRHLink.subscribe(() => void api.pollStatusNow().catch(() => undefined));
  sharedLiveTimeRelay.start();

  const initialLost = connectionLostSnapshot();
  if (initialLost.lost) {
    connLostOverlay.show(initialLost.serverUrl);
    return;
  }

  // Keep the radar boot sequence visible long enough to enjoy even on fast local/cached loads
  const fastBoot = Boolean((window as { __SLAPRF_E2E_FAST_BOOT__?: boolean }).__SLAPRF_E2E_FAST_BOOT__);
  const elapsedMs = performance.now() - bootStartMs;
  const remainingMs = fastBoot ? 0 : Math.max(0, MIN_BOOT_LOADER_MS - elapsedMs);
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
    if (!fastBoot) {
      await sleep(260);
    }
  }

  dismissBootLoader();
}

const start = () => {
  initAppTheme();
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
