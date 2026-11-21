import { icons } from "./core/icons";
import { ApiClient } from "./services/api_client";
import { HubLink, LATEST_FIRMWARE_VERSION, buildOrPatchFirmwareBin, setFirmwareBaseDir } from "./services/esp_flasher";
import { enableStandaloneWebSerialMode } from "./services/sim_serial_port";
import { AppStore } from "./state/store";
import { TimerFlasher } from "./widgets/TimerFlasher";

enableStandaloneWebSerialMode();

function syncTheme(shadowWrap: HTMLElement): void {
  const isDark = document.documentElement.classList.contains("dark");
  shadowWrap.dataset.theme = isDark ? "dark" : "light";
}

class DocsFlasherModal {
  private readonly host: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly flasherSlot: HTMLElement;
  private readonly cssReady: Promise<void>;
  private isOpen = false;
  private flasherMounted = false;

  constructor(fwBase: string, cssUrl: string) {
    setFirmwareBaseDir(fwBase);

    this.host = document.createElement("div");
    this.host.id = "slaprf-docs-flasher-modal-host";
    document.body.appendChild(this.host);

    const shadow = this.host.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssUrl;
    this.cssReady = new Promise<void>((resolve) => {
      link.onload = () => resolve();
      link.onerror = () => resolve();
    });
    shadow.appendChild(link);

    const wrap = document.createElement("div");
    wrap.className = "docs-flasher-theme-root";
    syncTheme(wrap);

    const tpl = document.getElementById("slaprf-docs-flasher-template") as HTMLTemplateElement | null;
    if (tpl) {
      wrap.appendChild(tpl.content.cloneNode(true));
    }

    const iconSlot = wrap.querySelector<HTMLElement>('[data-df-icon="1"]');
    if (iconSlot) iconSlot.innerHTML = icons.zap(18);

    const verSlot = wrap.querySelector<HTMLElement>('[data-df-version="1"]');
    if (verSlot) verSlot.textContent = LATEST_FIRMWARE_VERSION;

    const closeBtn = wrap.querySelector<HTMLElement>('[data-df-close="1"]');
    if (closeBtn) closeBtn.innerHTML = icons.close(16);

    shadow.appendChild(wrap);

    this.backdrop = wrap.querySelector<HTMLElement>(".df-modal-backdrop")!;
    this.bodyEl = wrap.querySelector<HTMLElement>(".df-modal-body")!;
    this.flasherSlot = wrap.querySelector<HTMLElement>('[data-slot="flasher"]')!;

    this.backdrop.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-df-close]")) {
        if (!this.isFlashingBusy()) this.close();
        return;
      }
      if (target === this.backdrop && !this.isFlashingBusy()) {
        this.close();
      }
    });

    // Prevent background page scroll while modal is open without hiding the window scrollbar (zero layout shift).
    this.backdrop.addEventListener(
      "wheel",
      (e) => {
        if (!this.isOpen) return;
        const path = e.composedPath();
        if (!path.includes(this.bodyEl)) {
          e.preventDefault();
          return;
        }
        const { scrollTop, scrollHeight, clientHeight } = this.bodyEl;
        const atTop = scrollTop <= 0 && e.deltaY < 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;
        if (scrollHeight <= clientHeight || atTop || atBottom) {
          e.preventDefault();
        }
      },
      { passive: false }
    );

    this.backdrop.addEventListener(
      "touchmove",
      (e) => {
        if (!this.isOpen) return;
        const path = e.composedPath();
        if (!path.includes(this.bodyEl) || this.bodyEl.scrollHeight <= this.bodyEl.clientHeight) {
          e.preventDefault();
        }
      },
      { passive: false }
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen && !this.isFlashingBusy()) {
        e.preventDefault();
        this.close();
      }
    });

    new MutationObserver(() => syncTheme(wrap)).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  private isFlashingBusy(): boolean {
    return !!this.flasherSlot.querySelector(".flasher-progress.is-flashing");
  }

  private ensureMounted(): void {
    if (this.flasherMounted) return;
    this.flasherMounted = true;

    const stubStore = {
      detectedTimers: [],
      simulatorRunning: false,
    } as unknown as AppStore;

    const stubApi = {
      fetchFirmwareImage: (role: "hub" | "spoke", timerLabel: string, fingerprint?: string, hubLink?: HubLink) =>
        buildOrPatchFirmwareBin({ role, timerLabel, fingerprint, hubLink }),
      provisionTimer: async () => undefined,
      refresh: async () => undefined,
    } as unknown as ApiClient;

    new TimerFlasher(this.flasherSlot, stubStore, stubApi, undefined, { hideTips: true });
  }

  public async open(): Promise<void> {
    await this.cssReady;
    this.ensureMounted();
    this.isOpen = true;
    this.backdrop.dataset.open = "true";
  }

  public close(): void {
    this.isOpen = false;
    this.backdrop.dataset.open = "false";
    if (window.location.hash === "#open-flasher") {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }
}

function initDocsFlasher(): void {
  const cfgEl = document.querySelector<HTMLElement>("[data-slaprf-flasher-config]");
  const fwBase = cfgEl?.dataset.firmwareBase || "/docs/firmware";
  const cssUrl = cfgEl?.dataset.cssUrl || "/docs/js/docs-flasher.css";

  let modal: DocsFlasherModal | null = null;
  const getModal = () => {
    if (!modal) modal = new DocsFlasherModal(fwBase, cssUrl);
    return modal;
  };

  if (document.querySelector('[data-open-docs-flasher], a[href$="#open-flasher"]')) {
    getModal();
  }

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const trigger = target.closest<HTMLElement>('[data-open-docs-flasher], a[href$="#open-flasher"]');
    if (trigger) {
      e.preventDefault();
      void getModal().open();
    }
  });

  if (window.location.hash === "#open-flasher") {
    void getModal().open();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDocsFlasher);
} else {
  initDocsFlasher();
}
