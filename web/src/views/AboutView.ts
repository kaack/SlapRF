import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

interface AboutBuildInfo {
  frontendVersion?: string;
  releaseTag?: string;
  commitHash?: string;
  branchName?: string;
  licenseSummary?: string;
  licenseFairSource?: string;
  licenseGpl?: string;
}

declare const __SLAPRF_ABOUT_INFO__: AboutBuildInfo | undefined;

const BUILD_INFO: AboutBuildInfo =
  typeof __SLAPRF_ABOUT_INFO__ !== "undefined" && __SLAPRF_ABOUT_INFO__
    ? __SLAPRF_ABOUT_INFO__
    : {};

const DEFAULT_LICENSE_SUMMARY = `This work is dual-licensed under "GNU General Public License, version 3"
and "Fair Source License, version 0.9"  (or any later version).

You can choose between one of them if you use this work.`;

const PAYPAL_DONATE_URL = "https://www.paypal.com/donate/?hosted_button_id=TRHRYKMZ8SM8W";
const YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@oneeyefpv";

function renderAppLogoSvg(): string {
  return `
    <svg class="about-logo-svg" viewBox="0 0 24 24" width="160" height="160" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <g transform="translate(0.6 -1.1)">
        <path class="about-logo-ring" d="M18.21 16.30A8.2 8.2 0 1 1 13.30 5.79" stroke-width="2.2" />
        <circle class="about-logo-hub" cx="10.5" cy="13.5" r="1.9" stroke="none" />
        <path class="about-logo-needle" d="M10.5 13.5L15.2 9.8" stroke-width="2.2" />
        <path class="about-logo-arc" d="M15.77 7.22A8.2 8.2 0 0 1 18.70 13.50" stroke-width="2.2" />
        <path class="about-logo-arc is-outer" d="M17.64 4.36A11.6 11.6 0 0 1 22.09 13.90" stroke-width="2.2" />
      </g>
    </svg>`;
}

function renderYouTubeIconSvg(): string {
  return `
    <svg class="about-yt-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 22" width="26" height="18" aria-hidden="true">
      <g transform="matrix(0.4727260172367096, 0, 0, 0.4727260172367096, -226.33656311035156, -159.36195373535156)">
        <g transform="matrix(0.062132, 0, 0, 0.062132, 480.657104, 338.148163)">
          <linearGradient id="slaprf_yt_grad" gradientUnits="userSpaceOnUse" x1="512.5" y1="719.7" x2="512.5" y2="1.2" gradientTransform="matrix(1 0 0 -1 0 721)">
            <stop offset="0" stop-color="#E52D27" />
            <stop offset="1" stop-color="#BF171D" />
          </linearGradient>
          <path fill="url(#slaprf_yt_grad)" d="M1013,156.3c0,0-10-70.4-40.6-101.4C933.6,14.2,890,14,870.1,11.6C727.1,1.3,512.7,1.3,512.7,1.3 h-0.4c0,0-214.4,0-357.4,10.3C135,14,91.4,14.2,52.6,54.9C22,85.9,12,156.3,12,156.3S1.8,238.9,1.8,321.6v77.5 C1.8,481.8,12,564.4,12,564.4s10,70.4,40.6,101.4c38.9,40.7,89.9,39.4,112.6,43.7c81.7,7.8,347.3,10.3,347.3,10.3 s214.6-0.3,357.6-10.7c20-2.4,63.5-2.6,102.3-43.3c30.6-31,40.6-101.4,40.6-101.4s10.2-82.7,10.2-165.3v-77.5 C1023.2,238.9,1013,156.3,1013,156.3z M407,493V206l276,144L407,493z" />
        </g>
        <path fill="#FFFFFF" d="M 505.945 368.779 L 523.094 359.895 L 505.945 350.947 L 505.945 368.779 Z" />
        <path opacity="0.12" fill="#420000" d="M 505.945 350.947 L 520.981 360.988 L 523.094 359.895 L 505.945 350.947 Z" />
      </g>
    </svg>`;
}

function renderPayPalIconSvg(): string {
  return `
    <svg class="about-paypal-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 338.667 89.785" width="96" height="24" aria-hidden="true">
      <g transform="translate(936.898 -21.779)">
        <path d="M-828.604 39.734c-.697 0-1.289.506-1.398 1.195l-8.068 51.165a1.31 1.31 0 0 0 1.294 1.513h9.568c.696 0 1.289-.507 1.398-1.195l2.37-15.025c.108-.688.701-1.195 1.398-1.195h8.699c10.164 0 18.792-7.416 20.368-17.465 1.589-10.134-6.328-18.971-17.549-18.993zm9.301 11.422h6.96c5.73 0 7.596 3.381 7.006 7.12-.59 3.747-3.488 6.507-9.031 6.507h-7.084zm45.788 3.478c-2.416.009-5.196.504-8.317 1.804-7.159 2.984-10.597 9.151-12.057 13.647 0 0-4.647 13.717 5.852 21.253 0 0 9.737 7.255 20.698-.447l-.189 1.203a1.31 1.31 0 0 0 1.292 1.513h9.083c.697 0 1.289-.507 1.398-1.195l5.525-35.038a1.31 1.31 0 0 0-1.292-1.515h-9.083c-.697 0-1.29.507-1.398 1.195l-.297 1.886s-3.967-4.333-11.216-4.306zm.297 11.067c1.043 0 1.997.144 2.853.419 3.919 1.258 6.141 5.023 5.498 9.104-.793 5.025-4.914 8.725-10.199 8.725-1.042 0-1.996-.143-2.853-.418-3.918-1.258-6.154-5.023-5.511-9.104.793-5.025 4.927-8.727 10.212-8.727z" fill="#003087" />
        <path d="M-697.804 39.734c-.697 0-1.289.506-1.398 1.195l-8.068 51.165a1.31 1.31 0 0 0 1.294 1.513h9.568c.696 0 1.289-.507 1.398-1.195l2.37-15.025c.108-.688.701-1.195 1.398-1.195h8.699c10.164 0 18.791-7.416 20.366-17.465 1.59-10.134-6.326-18.971-17.547-18.993zm9.301 11.422h6.96c5.73 0 7.596 3.381 7.006 7.12-.59 3.747-3.487 6.507-9.031 6.507h-7.084zm45.787 3.478c-2.416.009-5.196.504-8.317 1.804-7.159 2.984-10.597 9.151-12.057 13.647 0 0-4.645 13.717 5.854 21.253 0 0 9.735 7.255 20.697-.447l-.189 1.203a1.31 1.31 0 0 0 1.294 1.513h9.082c.697 0 1.289-.507 1.398-1.195l5.527-35.038a1.31 1.31 0 0 0-1.294-1.515h-9.083c-.697 0-1.29.507-1.398 1.195l-.297 1.886s-3.967-4.333-11.216-4.306zm.297 11.067c1.043 0 1.997.144 2.853.419 3.919 1.258 6.141 5.023 5.498 9.104-.793 5.025-4.914 8.725-10.199 8.725-1.042 0-1.996-.143-2.853-.418-3.918-1.258-6.154-5.023-5.511-9.104.793-5.025 4.927-8.727 10.212-8.727z" fill="#0070e0" />
        <path d="M-745.92 55.859c-.72 0-1.232.703-1.012 1.388l9.958 30.901-9.004 14.562c-.437.707.071 1.62.902 1.62h10.642a1.77 1.77 0 0 0 1.513-.854l27.811-46.007c.427-.707-.083-1.611-.909-1.611h-10.641a1.77 1.77 0 0 0-1.522.869l-10.947 18.482-5.557-18.345c-.181-.597-.732-1.006-1.355-1.006z" fill="#003087" />
        <path d="M-609.107 39.734c-.696 0-1.289.507-1.398 1.195l-8.07 51.163a1.31 1.31 0 0 0 1.294 1.515h9.568c.696 0 1.289-.507 1.398-1.195l8.068-51.165a1.31 1.31 0 0 0-1.292-1.513z" fill="#0070e0" />
        <path d="M-908.37 39.734a2.59 2.59 0 0 0-2.556 2.185l-4.247 26.936c.198-1.258 1.282-2.185 2.556-2.185h12.445c12.525 0 23.153-9.137 25.095-21.519a20.76 20.76 0 0 0 .245-2.793c-3.183-1.669-6.922-2.624-11.019-2.624z" fill="#001c64" />
        <path d="M-874.832 42.359a20.76 20.76 0 0 1-.245 2.793c-1.942 12.382-12.571 21.519-25.095 21.519h-12.445c-1.273 0-2.358.926-2.556 2.185l-3.905 24.752-2.446 15.528a2.1 2.1 0 0 0 2.075 2.43h13.508a2.59 2.59 0 0 0 2.556-2.185l3.558-22.567a2.59 2.59 0 0 1 2.558-2.185h7.953c12.525 0 23.153-9.137 25.095-21.519 1.379-8.788-3.047-16.784-10.611-20.75z" fill="#0070e0" />
        <path d="M-923.716 21.779c-1.273 0-2.358.926-2.556 2.183l-10.6 67.216c-.201 1.276.785 2.43 2.077 2.43h15.719l3.903-24.752 4.247-26.936a2.59 2.59 0 0 1 2.556-2.185h22.519c4.098 0 7.836.956 11.019 2.624.218-11.273-9.084-20.58-21.873-20.58z" fill="#003087" />
      </g>
    </svg>`;
}

export class AboutView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private backendVersion: string;
  private activeLicense: "gpl" | "fair-source" | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    const fallbackTag = BUILD_INFO.releaseTag || "(devel)";
    const fallbackCommit = (BUILD_INFO.commitHash || "unknown").substring(0, 7);
    this.backendVersion = `${fallbackTag}-${fallbackCommit}`;

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const openBtn = target.closest<HTMLElement>("[data-open-license]");
      if (openBtn) {
        e.preventDefault();
        const kind = openBtn.dataset.openLicense as "gpl" | "fair-source";
        this.activeLicense = this.activeLicense === kind ? null : kind;
        this.render();
        return;
      }
      if (target.closest("[data-close-license]") || target.classList.contains("about-license-backdrop")) {
        this.activeLicense = null;
        this.render();
        return;
      }
      const donateBtn = target.closest<HTMLElement>("[data-donate-paypal]");
      if (donateBtn) {
        window.open(PAYPAL_DONATE_URL, "_blank", "noreferrer");
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.activeLicense !== null) {
        this.activeLicense = null;
        this.render();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    this.onDispose(() => window.removeEventListener("keydown", onKeyDown));

    this.render();
    void this.loadBackendVersion();
  }

  private async loadBackendVersion(): Promise<void> {
    try {
      const info = await this.api.getVersionInfo();
      if (info && info.release_tag && info.commit_hash) {
        const nextVer = `${info.release_tag}-${info.commit_hash.substring(0, 7)}`;
        if (nextVer !== this.backendVersion) {
          this.backendVersion = nextVer;
          this.render();
        }
      }
    } catch {
      // Keep build-time fallback version
    }
  }

  private render(): void {
    const frontendVersion = BUILD_INFO.frontendVersion || "0.1.0";
    const licenseSummary = BUILD_INFO.licenseSummary || DEFAULT_LICENSE_SUMMARY;

    const modalTitle =
      this.activeLicense === "gpl"
        ? "GNU General Public License, version 3"
        : "Fair Source License, version 0.9";
    const modalText =
      this.activeLicense === "gpl"
        ? BUILD_INFO.licenseGpl || "GNU General Public License v3.0"
        : BUILD_INFO.licenseFairSource || "Fair Source License, version 0.9";

    this.el.innerHTML = `
      <div class="card about-card">
        <div class="about-hero">
          <div class="about-app-title">SlapRF</div>
          <div class="about-app-subtitle">5.8 GHz Multi-Gate FPV Lap &amp; Sector Timer</div>
          <div class="about-logo-wrap">
            ${renderAppLogoSvg()}
          </div>
          <div class="about-versions">
            <div>Frontend version: <span class="mono strong">${esc(frontendVersion)}</span></div>
            <div>Backend version: <span class="mono strong">${esc(this.backendVersion)}</span></div>
          </div>

          <div class="about-author-row">
            <span>Designed, and developed by</span>
            <a class="about-yt-link" href="${YOUTUBE_CHANNEL_URL}" target="_blank" rel="noopener noreferrer">
              ${renderYouTubeIconSvg()}
              <span>@OneEyeFPV</span>
            </a>
          </div>

          <div class="about-donate-box">
            <p>Show your support by donating to my daily drinks 🧋 fund through PayPal.</p>
            <button type="button" class="about-paypal-btn" data-donate-paypal="1" title="Donate via PayPal" aria-label="Donate via PayPal">
              ${renderPayPalIconSvg()}
            </button>
          </div>
        </div>

        <div class="about-divider"></div>

        <div class="about-body">
          <p class="about-thanks">
            <strong>Disclaimer:</strong> This software is developed using Agentic AI coding workflows and is provided "as is", without any express or implied guarantees or warranties of any kind.
          </p>

          <div class="about-licenses">
            <h3>Licenses</h3>
            <p class="about-license-summary">${esc(licenseSummary).replace(/\n/g, "<br/>")}</p>
            <div class="about-license-links">
              <a href="#/about" class="about-license-link" data-open-license="gpl">GNU General Public License</a>
              <a href="#/about" class="about-license-link" data-open-license="fair-source">Fair Source License</a>
            </div>
          </div>
        </div>
      </div>

      ${
        this.activeLicense
          ? `
            <div class="about-license-backdrop" role="dialog" aria-modal="true" aria-label="${esc(modalTitle)}">
              <div class="about-license-modal">
                <div class="about-license-modal-head">
                  <strong>${esc(modalTitle)}</strong>
                  <button type="button" class="btn btn-sm btn-icon btn-ghost" data-close-license="1" aria-label="Close license viewer">
                    ${icons.close(16)}
                  </button>
                </div>
                <pre class="about-license-pre">${esc(modalText)}</pre>
              </div>
            </div>`
          : ""
      }`;
  }
}
