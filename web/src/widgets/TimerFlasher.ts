import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  FlashProgress,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  flashXiaoC5OverWebSerial,
  isWebSerialSupported,
} from "../services/esp_flasher";
import { recordKnownTimerReadout, sharedTimerConsole } from "../services/timer_console";
import { AppStore } from "../state/store";

const FLASHER_PREFS_STORAGE_KEY = "slaprf.ui.flasher_prefs.v1";

type WizardStepId = "network" | "identity" | "flash";

/**
 * Interactive Hub & Spoke network flasher wizard for Seeed Studio XIAO ESP32-C5 timers.
 *
 *   - Step 1 (`network`): Pick the **Hub** or **Spoke** role via pictorial cards; Spoke reveals
 *     the **S1–S6** slot chips.
 *   - Step 2 (`identity`): Set **Timer ID / name** (pre-filled from the node you clicked). Every timer
 *     gets the same firmware; only the role, name and fingerprint differ.
 *   - Step 3 (`flash`): Summary receipt + **Flash to USB** / **Download .bin**.
 *
 * The Hub is a USB dongle that talks to this computer over USB serial only, so there is no
 * Wi-Fi setup step.
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onReadout?: (readout: TimerReadout) => void;

  private step: WizardStepId = "network";
  private slideDir: "next" | "prev" | "none" = "none";
  private role: "hub" | "spoke" = "hub";
  private flashedNodes = new Set<string>();
  private timerLabel = "H1";
  /** Keep the board's existing fingerprint when reflashing (vs. mint a new one). */
  private keepFingerprint = true;
  private busy = false;
  private progress: FlashProgress | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(
    el: HTMLElement,
    store: AppStore,
    api: ApiClient,
    onReadout?: (readout: TimerReadout) => void
  ) {
    super(el);
    this.store = store;
    this.api = api;
    this.onReadout = onReadout;

    try {
      const rawPrefs = window.localStorage.getItem(FLASHER_PREFS_STORAGE_KEY);
      if (rawPrefs) {
        const parsed = JSON.parse(rawPrefs) as {
          step?: WizardStepId;
          role?: "hub" | "spoke";
          timerLabel?: string;
          keepFingerprint?: boolean;
          showAllPorts?: boolean;
        };
        if (parsed.role === "hub" || parsed.role === "spoke") {
          this.role = parsed.role;
        }
        if (parsed.step === "network" || parsed.step === "identity" || parsed.step === "flash") {
          this.step = parsed.step;
        }
        if (typeof parsed.timerLabel === "string" && parsed.timerLabel.trim() !== "") {
          this.timerLabel = parsed.timerLabel;
        }
        if (typeof parsed.keepFingerprint === "boolean") {
          this.keepFingerprint = parsed.keepFingerprint;
        }
        if (typeof parsed.showAllPorts === "boolean") {
          this.showAllPorts = parsed.showAllPorts;
        }
      }
    } catch {
      // ignore storage errors
    }

    this.listen(el, "click", (e) => {
      const t = e.target as HTMLElement;

      if (this.busy) return;

      const gotoStepBtn = t.closest<HTMLElement>("[data-goto-step]");
      if (gotoStepBtn) {
        const targetStep = gotoStepBtn.dataset.gotoStep as WizardStepId;
        this.navigateToStep(targetStep);
        return;
      }

      const pickRole = t.closest<HTMLElement>("[data-pick-role]");
      if (pickRole) {
        const nextRole = pickRole.dataset.pickRole === "spoke" ? "spoke" : "hub";
        if (nextRole !== this.role) {
          this.role = nextRole;
          this.timerLabel = nextRole === "hub" ? "H1" : this.suggestSpokeLabel();
          this.saveFlasherPrefs();
          this.errorMsg = null;
          this.lastSuccessMsg = null;
          this.slideDir = "none";
          this.render();
        }
        return;
      }

      if (t.closest("[data-wizard-next]")) {
        this.advanceStep();
        return;
      }

      if (t.closest("[data-wizard-prev]")) {
        this.retreatStep();
        return;
      }

      if (t.closest("[data-finish-wizard]") || t.closest("[data-flash-another]")) {
        this.errorMsg = null;
        this.lastSuccessMsg = null;
        this.progress = null;
        if (this.role === "spoke") {
          this.timerLabel = this.suggestSpokeLabel();
        }
        this.goToStep("network", "prev");
        return;
      }

      if (t.closest("[data-flash-usb]")) {
        void this.flashUsb();
        return;
      }

      if (t.closest("[data-download-bin]")) {
        void this.downloadBin();
        return;
      }

      if (t.closest("[data-restore-defaults]")) {
        this.step = "network";
        this.role = "hub";
        this.timerLabel = "H1";
        this.keepFingerprint = true;
        this.showAllPorts = false;
        this.errorMsg = null;
        this.lastSuccessMsg = null;
        this.progress = null;
        this.slideDir = "none";
        this.saveFlasherPrefs();
        this.render();
        return;
      }
    });

    this.listen(el, "keydown", (e) => {
      if (e.key === "Enter") {
        const target = e.target as HTMLElement;
        if (target.matches("[data-timer-label]")) {
          e.preventDefault();
          this.advanceStep();
        }
      }
    });

    this.listen(el, "input", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.matches("[data-timer-label]")) {
        this.timerLabel = input.value;
        this.saveFlasherPrefs();
      }
    });

    this.listen(el, "change", (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.matches("[data-all-ports]")) {
        this.showAllPorts = (target as HTMLInputElement).checked;
        this.saveFlasherPrefs();
      } else if (target.matches("[data-keep-fp]")) {
        this.keepFingerprint = target.value === "keep";
        this.saveFlasherPrefs();
        this.slideDir = "none";
        this.render();
      }
    });

    this.render();
  }

  private get orderedSteps(): Array<{ id: WizardStepId; title: string; short: string }> {
    return [
      { id: "network", title: "Select role", short: "Role" },
      { id: "identity", title: "Name timer", short: "Name" },
      { id: "flash", title: "Flash timer", short: "Flash" },
    ];
  }

  private saveFlasherPrefs(): void {
    try {
      window.localStorage.setItem(
        FLASHER_PREFS_STORAGE_KEY,
        JSON.stringify({
          step: this.step,
          role: this.role,
          timerLabel: this.timerLabel,
          keepFingerprint: this.keepFingerprint,
          showAllPorts: this.showAllPorts,
        })
      );
    } catch {
      // ignore storage errors
    }
  }

  private goToStep(next: WizardStepId, dir: "next" | "prev" | "none"): void {
    this.step = next;
    this.slideDir = dir;
    this.errorMsg = null;
    this.saveFlasherPrefs();
    this.render();
  }

  private navigateToStep(target: WizardStepId): void {
    const steps = this.orderedSteps.map((s) => s.id);
    const curIdx = steps.indexOf(this.step);
    const targetIdx = steps.indexOf(target);
    if (targetIdx === -1 || targetIdx === curIdx) return;

    if (targetIdx > curIdx) {
      if (curIdx <= steps.indexOf("identity") && targetIdx > steps.indexOf("identity")) {
        if (!this.validateIdentityStep()) return;
      }
    }

    this.goToStep(target, targetIdx > curIdx ? "next" : "prev");
  }

  private validateIdentityStep(): boolean {
    if (!this.timerLabel.trim()) {
      this.errorMsg = "Give this timer a name (e.g. H1, S1, S2) before continuing.";
      this.slideDir = "none";
      this.render();
      this.el.querySelector<HTMLInputElement>("[data-timer-label]")?.focus();
      return false;
    }
    return true;
  }

  private advanceStep(): void {
    if (this.step === "network") {
      this.goToStep("identity", "next");
      return;
    }
    if (this.step === "identity") {
      if (!this.validateIdentityStep()) return;
      this.goToStep("flash", "next");
    }
  }

  private retreatStep(): void {
    if (this.step === "flash") {
      this.goToStep("identity", "prev");
      return;
    }
    if (this.step === "identity") {
      this.goToStep("network", "prev");
    }
  }

  private get roleLabel(): string {
    return this.role === "hub" ? "Hub" : "Spoke";
  }

  /** Next spoke name (S1, S2, …) not already used by a detected timer or one flashed this session. */
  private suggestSpokeLabel(): string {
    const taken = new Set<string>();
    for (const d of this.store.detectedTimers) {
      if (d.timerLabel) taken.add(d.timerLabel.trim().toUpperCase());
    }
    for (const key of this.flashedNodes) {
      if (key.startsWith("spoke:")) taken.add(key.slice(6));
    }
    for (let n = 1; n <= 99; n++) {
      if (!taken.has(`S${n}`)) return `S${n}`;
    }
    return "S1";
  }

  public applyReadout(info: TimerReadout): void {
    recordKnownTimerReadout(info);
    if (this.busy) return;
    this.role = info.role;
    if (info.timerLabel) {
      this.timerLabel = info.timerLabel;
    }
    this.slideDir = "none";
    this.render();
  }

  private async flashUsb(): Promise<void> {
    if (!this.validateIdentityStep()) {
      return;
    }
    const cleanLabel = this.timerLabel.trim();
    const label = `${this.role === "hub" ? "Hub" : "Spoke"} "${cleanLabel}"`;
    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.slideDir = "none";
    this.progress = {
      stage: "connecting",
      percent: 1,
      detail: `Building ${label} firmware image…`,
    };
    this.render();

    try {
      const { bytes } = await this.api.fetchFirmwareImage(this.role, cleanLabel);

      const written = await flashXiaoC5OverWebSerial(
        bytes,
        label,
        (p) => {
          this.progress = p;
          this.slideDir = "none";
          if (!this.updateProgressInPlace(cleanLabel)) {
            this.render();
          }
        },
        this.showAllPorts,
        this.keepFingerprint,
        sharedTimerConsole
      );

      if (written) {
        recordKnownTimerReadout(written);
        this.onReadout?.(written);
      }
      await this.api.provisionTimer(this.role, cleanLabel, written?.fingerprint ?? "");
      this.flashedNodes.add(this.role === "hub" ? "hub" : `spoke:${cleanLabel.toUpperCase()}`);
      const fpNote = written?.fingerprintKept
        ? `kept its fingerprint ${written.fingerprint}`
        : `got new fingerprint ${written?.fingerprint ?? ""}`;
      this.lastSuccessMsg = `${label} flashed and ${fpNote} — added to Timers & Track.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/No port selected|aborted|cancelled/i.test(msg)) {
        this.errorMsg = null;
      } else {
        this.errorMsg = msg;
      }
    } finally {
      this.busy = false;
      this.progress = null;
      this.slideDir = "none";
      this.render();
    }
  }

  private updateProgressInPlace(cleanLabel: string): boolean {
    if (this.step !== "flash" || !this.progress) return false;
    const statusEl = this.el.querySelector<HTMLElement>(".flasher-progress-status");
    const pctEl = this.el.querySelector<HTMLElement>(".flasher-progress-pct");
    const fillEl = this.el.querySelector<HTMLElement>(".flasher-meter .meter-fill");
    const btnTextEl = this.el.querySelector<HTMLElement>(".flasher-btn-flash span:last-child");
    if (!statusEl || !pctEl || !fillEl) return false;
    const pct = Math.max(0, Math.min(100, Math.round(this.progress.percent)));
    statusEl.textContent = this.progress.detail;
    pctEl.textContent = `${pct}%`;
    fillEl.style.width = `${pct}%`;
    if (btnTextEl) {
      btnTextEl.textContent = `Flashing ${cleanLabel}… (${pct}%)`;
    }
    return true;
  }

  private async downloadBin(): Promise<void> {
    if (!this.validateIdentityStep()) {
      return;
    }
    try {
      const cleanLabel = this.timerLabel.trim();
      const { bytes, filename } = await this.api.fetchFirmwareImage(this.role, cleanLabel);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
      this.slideDir = "none";
      this.render();
    }
  }

  private renderStepper(): string {
    const steps = this.orderedSteps;
    const currentIndex = steps.findIndex((s) => s.id === this.step);

    return `
      <div class="flasher-wizard-stepper" role="tablist" aria-label="Firmware flasher steps">
        ${steps
          .map((s, idx) => {
            const isCurrent = idx === currentIndex;
            const isDone = idx < currentIndex;
            const stateCls = isCurrent ? "is-current" : isDone ? "is-done" : "is-upcoming";
            return `
              <button
                type="button"
                class="flasher-step-pill ${stateCls}"
                data-goto-step="${s.id}"
                ${this.busy ? "disabled" : ""}
                aria-current="${isCurrent ? "step" : "false"}"
              >
                <span class="flasher-step-circle">${isDone ? "✓" : idx + 1}</span>
                <span class="flasher-step-label-full">${esc(s.title)}</span>
                <span class="flasher-step-label-short">${esc(s.short)}</span>
              </button>`;
          })
          .join(`<span class="flasher-step-divider" aria-hidden="true"></span>`)}
      </div>`;
  }

  /**
   * Step 1: Role picker using pictorial cards.
   * Pick **Hub** (one per network) or **Spoke**; picking Spoke reveals the S1–S6 slot chips.
   */
  private renderStepNetwork(): string {
    const isHub = this.role === "hub";
    const hubFlashed = this.flashedNodes.has("hub");
    const flashedSpokes = [...this.flashedNodes].filter((k) => k.startsWith("spoke:")).length;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="note">Step 1 of 3 · One Hub plus up to 6 Spokes per course</span>
          </div>
          <h3>What role will this timer play?</h3>
        </div>

        <div class="flasher-pictorial-grid" role="radiogroup" aria-label="Timer role">
          <button
            type="button"
            role="radio"
            aria-checked="${isHub}"
            class="flasher-pictorial-card ${isHub ? "is-active" : ""}"
            data-pick-role="hub"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Hub</span>
              <span class="badge ${isHub ? "tone-good" : ""}">${hubFlashed ? "✓ Flashed" : "H1 · 1 per course"}</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRoleHub()}
            </div>
            <p class="flasher-pictorial-desc">
              USB dongle plugged into this computer. Collects every Spoke's passes over long-range ESP-NOW and streams them over USB-C.
            </p>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${!isHub}"
            class="flasher-pictorial-card ${!isHub ? "is-active" : ""}"
            data-pick-role="spoke"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Spoke</span>
              <span class="badge ${!isHub ? "tone-good" : ""}">${
                flashedSpokes > 0 ? `✓ ${flashedSpokes} flashed` : "Up to 6 · Sector gates"
              }</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRoleSpoke()}
            </div>
            <p class="flasher-pictorial-desc">
              Placed at each sector gate around the course. Sends its passes to the Hub over long-range ESP-NOW.
            </p>
          </button>
        </div>

        <div class="flasher-wizard-nav is-end">
          <button type="button" class="btn" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  /** Pictorial for the Hub role: Spokes ──▶ Hub ◀── Laptop (USB-C). */
  private renderPictorialRoleHub(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-role-hub" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <line x1="52" y1="14" x2="114" y2="30" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-hub)" />
        <line x1="52" y1="34" x2="114" y2="34" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-hub)" />
        <line x1="52" y1="54" x2="114" y2="38" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-hub)" />
        <line x1="214" y1="34" x2="166" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-role-hub)" />

        <g transform="translate(40, 14)"><circle r="9" class="flasher-pic-node is-dim-node" /></g>
        <g transform="translate(40, 34)"><circle r="9" class="flasher-pic-node is-dim-node" /></g>
        <g transform="translate(40, 54)"><circle r="9" class="flasher-pic-node is-dim-node" /></g>

        <g transform="translate(140, 34)">
          <circle r="22" class="flasher-pic-node is-hub-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Hub</text>
        </g>

        <g transform="translate(238, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`;
  }

  /** Pictorial for the Spoke role: Spoke ──ESP-NOW──▶ Hub. */
  private renderPictorialRoleSpoke(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-role-spoke" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <line x1="96" y1="34" x2="182" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-role-spoke)" />
        <text x="139" y="26" text-anchor="middle" class="flasher-pic-link-label">ESP-NOW LR</text>

        <g transform="translate(72, 34)">
          <circle r="20" class="flasher-pic-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Spoke</text>
        </g>

        <g transform="translate(208, 34)">
          <circle r="20" class="flasher-pic-node is-dim-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title is-dim">Hub</text>
        </g>
      </svg>`;
  }

  private renderStepIdentity(): string {
    const isHub = this.role === "hub";
    const idPlaceholder = isHub ? "e.g. H1" : "e.g. S1";

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge ${isHub ? "tone-good" : ""}">Role: ${
              isHub ? "Hub" : "Spoke"
            }</span>
            <span class="note">${
              isHub
                ? "Step 2 of 3 · Stamped into XIAO flash"
                : "Step 2 of 3 · Stamped into XIAO flash (auto-pairs with Hub)"
            }</span>
          </div>
          <h3>Name this ${isHub ? "Hub" : "Spoke"}</h3>
          <p>The name is how this timer shows up in Timers and on the Track.</p>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer name</label>
            <input
              class="input mono"
              type="text"
              placeholder="${idPlaceholder}"
              value="${esc(this.timerLabel)}"
              data-timer-label="1"
              maxlength="24"
              spellcheck="false"
              autocomplete="off"
              ${this.busy ? "disabled" : ""}
            />
          </div>

          <div class="flasher-field">
            <label class="flasher-field-label">Firmware</label>
            <div class="input mono" aria-label="Firmware version">SlapRF ${LATEST_FIRMWARE_VERSION}</div>
          </div>
        </div>

        <div class="flasher-wizard-nav">
          <button type="button" class="btn" data-wizard-prev="1" ${this.busy ? "disabled" : ""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  private renderStepFlash(webSerialOk: boolean): string {
    const isHub = this.role === "hub";
    const cleanLabel = this.timerLabel.trim() || (isHub ? "H1" : this.suggestSpokeLabel());
    const linkSummary = isHub ? "USB-C dongle → this computer" : "ESP-NOW → Hub";

    const pct = this.progress ? this.progress.percent : this.lastSuccessMsg ? 100 : 0;
    const statusText = this.progress
      ? this.progress.detail
      : this.lastSuccessMsg
      ? `✓ ${this.lastSuccessMsg}`
      : `Ready to flash ${cleanLabel} over USB-C`;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>Ready to flash ${esc(cleanLabel)}</h3>
          <p>Plug your <strong>Seeed Studio XIAO ESP32-C5</strong> into USB-C and click <strong>Flash to USB</strong>.</p>
        </div>

        <div class="flasher-receipt">
          <div class="flasher-receipt-item">
            <span class="note">Role</span>
            <div class="flasher-receipt-val">
              <span class="badge ${isHub ? "tone-good" : ""}">${
                isHub ? "Hub" : "Spoke"
              }</span>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">Timer &amp; Firmware</span>
            <div class="flasher-receipt-val">
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">${isHub ? "Computer Link" : "Radio Link"}</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(linkSummary)}</span>
            </div>
          </div>
        </div>

        <div class="flasher-fp-option" role="radiogroup" aria-label="Board fingerprint">
          <span class="flasher-field-label">Board fingerprint</span>
          <div class="flasher-fp-choices">
            <label class="flasher-fp-choice ${this.keepFingerprint ? "is-active" : ""}">
              <input type="radio" name="flasher-fp" value="keep" data-keep-fp="keep" ${this.keepFingerprint ? "checked" : ""} ${this.busy ? "disabled" : ""} />
              <span><strong>Keep existing</strong> · Reflash or update this board; it stays the same timer with its color, gate, and history.</span>
            </label>
            <label class="flasher-fp-choice ${!this.keepFingerprint ? "is-active" : ""}">
              <input type="radio" name="flasher-fp" value="new" data-keep-fp="new" ${!this.keepFingerprint ? "checked" : ""} ${this.busy ? "disabled" : ""} />
              <span><strong>Generate new</strong> · Repurposed or swapped board; it shows up as a brand-new timer.</span>
            </label>
          </div>
        </div>

        <div class="flasher-progress ${this.busy ? "is-flashing" : ""} ${this.lastSuccessMsg && !this.busy ? "is-complete" : ""}">
          <div class="flasher-progress-top">
            <span class="flasher-progress-status">${esc(statusText)}</span>
            <span class="mono flasher-progress-pct">${pct}%</span>
          </div>
          <div class="meter flasher-meter">
            <span class="meter-fill ${this.lastSuccessMsg && !this.busy ? "tone-good" : ""}" style="width:${pct}%"></span>
          </div>
          <div class="flasher-progress-foot">
            <label class="flasher-port-toggle">
              <input
                type="checkbox"
                data-all-ports="1"
                ${this.showAllPorts ? "checked" : ""}
                ${this.busy ? "disabled" : ""}
              />
              <span>Show all USB serial ports</span>
            </label>
            <div class="flasher-progress-foot-actions">
              ${
                this.lastSuccessMsg && !this.busy
                  ? `<button type="button" class="btn btn-sm btn-armed" data-finish-wizard="1">${icons.check(14)}<span>Finish</span></button>`
                  : ""
              }
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-download-bin="1"
                ${this.busy ? "disabled" : ""}
                title="Download the pre-configured .bin image"
              >
                <span>Download .bin</span>
              </button>
            </div>
          </div>
        </div>

        ${
          !webSerialOk
            ? `<p class="note">Direct USB reading and flashing requires Chrome, Edge, or Brave.</p>`
            : ""
        }

        <div class="flasher-wizard-nav">
          <button
            type="button"
            class="btn"
            data-wizard-prev="1"
            ${this.busy ? "disabled" : ""}
          >
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>

          ${
            this.lastSuccessMsg && !this.busy
              ? `<div class="row" style="gap: 8px;">
                  <button
                    type="button"
                    class="btn"
                    data-flash-usb="1"
                    ${!webSerialOk ? "disabled" : ""}
                  >
                    <span class="flasher-zap-icon">${icons.zap(15)}</span>
                    <span>Flash ${esc(cleanLabel)} again</span>
                  </button>
                  <button
                    type="button"
                    class="btn flasher-btn-flash"
                    data-finish-wizard="1"
                  >
                    ${icons.check(15)}
                    <span>Finish</span>
                  </button>
                </div>`
              : `<button
                  type="button"
                  class="btn flasher-btn-flash"
                  data-flash-usb="1"
                  ${this.busy || !webSerialOk ? "disabled" : ""}
                >
                  <span class="flasher-zap-icon">${icons.zap(15)}</span>
                  <span>${this.busy ? `Flashing ${esc(cleanLabel)}… (${pct}%)` : `Flash ${esc(cleanLabel)} to USB`}</span>
                </button>`
          }
        </div>
      </div>`;
  }

  private render(): void {
    const webSerialOk = isWebSerialSupported();
    const animClass =
      this.slideDir === "next"
        ? "is-slide-next"
        : this.slideDir === "prev"
          ? "is-slide-prev"
          : "";

    let stepContent = "";
    switch (this.step) {
      case "network":
        stepContent = this.renderStepNetwork();
        break;
      case "identity":
        stepContent = this.renderStepIdentity();
        break;
      case "flash":
        stepContent = this.renderStepFlash(webSerialOk);
        break;
    }

    this.el.innerHTML = `
      <div class="card-body">
        <div class="flasher flasher-wizard">
          ${this.renderStepper()}

          <div class="flasher-wizard-viewport">
            <div class="flasher-wizard-stage ${animClass}">
              ${stepContent}
            </div>
          </div>

          ${
            this.step !== "flash" && this.progress
              ? `
            <div class="flasher-progress">
              <div class="flasher-progress-top">
                <span>${esc(this.progress.detail)}</span>
                <span class="mono">${this.progress.percent}%</span>
              </div>
              <div class="meter flasher-meter">
                <span class="meter-fill tone-good" style="width:${this.progress.percent}%"></span>
              </div>
            </div>`
              : ""
          }

          ${
            this.step !== "flash" && this.lastSuccessMsg && !this.busy
              ? `<div class="flasher-banner is-ok">✓ ${esc(this.lastSuccessMsg)}</div>`
              : ""
          }

          ${
            this.errorMsg && !this.busy
              ? `<div class="flasher-banner is-err">${esc(this.errorMsg)}</div>`
              : ""
          }
        </div>
      </div>
      <div class="rules-foot">
        <p class="note">Wizard choices are saved automatically on this browser.</p>
        <button class="btn btn-ghost btn-sm" type="button" data-restore-defaults="1" ${this.busy ? "disabled" : ""}>Restore defaults</button>
      </div>`;
  }
}
