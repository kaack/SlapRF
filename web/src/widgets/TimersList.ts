import { Component } from "../core/component";
import { esc } from "../core/format";
import { ApiClient } from "../services/api_client";
import { firmwareProfile, LATEST_FIRMWARE_VERSION } from "../services/esp_flasher";
import { TIMER_COLORS, timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { DetectedTimer } from "../types/models";
import { renderEmpty } from "./markup";

/**
 * Dedicated "Timers" section in System: purely physical information about all Seeed Studio
 * XIAO ESP32-C5 boards discovered over Wi-Fi / ESP-NOW or flashed over USB, whether currently
 * online or offline and whether assigned to the track or unassigned.
 */
export class TimersList extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private colorPickerTimerId: number | null = null;
  private activePopover: HTMLElement | null = null;
  private cleanupPopoverListeners: (() => void) | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const toggleSwatch = target.closest<HTMLElement>("[data-toggle-timer-color]");
      if (toggleSwatch) {
        e.preventDefault();
        e.stopPropagation();
        const timerId = Number(toggleSwatch.dataset.toggleTimerColor);
        if (this.colorPickerTimerId === timerId) {
          this.closeColorPopover();
          this.render();
        } else {
          this.openColorPopover(timerId, toggleSwatch);
        }
      }
    });

    const ageRefreshTimer = window.setInterval(() => this.render(), 1000);
    this.onDispose(() => window.clearInterval(ageRefreshTimer));
    this.onDispose(() => this.closeColorPopover());
    this.onDispose(store.subscribe(["config", "status"], () => this.render()));
    this.render();
  }

  private closeColorPopover(): void {
    if (this.cleanupPopoverListeners) {
      this.cleanupPopoverListeners();
      this.cleanupPopoverListeners = null;
    }
    if (this.activePopover) {
      this.activePopover.remove();
      this.activePopover = null;
    }
    this.colorPickerTimerId = null;
  }

  private positionColorPopover(anchorEl: HTMLElement, popover: HTMLElement): void {
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 10;

    const popRect = popover.getBoundingClientRect();
    const popW = popRect.width || 140;
    const popH = popRect.height || 104;

    let left = rect.left;
    if (left + popW > vw - margin) {
      left = Math.max(margin, vw - margin - popW);
    }
    left = Math.max(margin, left);

    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openAbove = spaceBelow < popH + 8 && spaceAbove > spaceBelow;

    popover.style.left = `${Math.round(left)}px`;
    if (openAbove) {
      popover.style.top = "auto";
      popover.style.bottom = `${Math.round(vh - rect.top + 8)}px`;
    } else {
      popover.style.bottom = "auto";
      popover.style.top = `${Math.round(rect.bottom + 8)}px`;
    }
  }

  private openColorPopover(timerId: number, swatchEl: HTMLElement): void {
    this.closeColorPopover();
    this.colorPickerTimerId = timerId;
    this.render();

    const currentSwatch =
      this.el.querySelector<HTMLElement>(`[data-toggle-timer-color="${timerId}"]`) ?? swatchEl;
    const color = timerColor(this.store, timerId);

    const popover = document.createElement("div");
    popover.className = "gate-color-popover";
    popover.setAttribute("role", "listbox");
    popover.setAttribute("aria-label", `Choose color for Timer ${timerId}`);
    popover.innerHTML = `
      <div class="gate-color-popover-grid">
        ${TIMER_COLORS.map((c) => {
          const selected = c.toLowerCase() === color.toLowerCase();
          return `
            <button
              type="button"
              class="gate-color-option ${selected ? "is-selected" : ""}"
              style="--c:${c}"
              data-pick-timer-color="${c}"
              data-for-timer="${timerId}"
              title="${c}"
              aria-label="Select color ${c}"
              aria-selected="${selected}"
            ></button>`;
        }).join("")}
      </div>`;

    document.body.appendChild(popover);
    this.activePopover = popover;
    this.positionColorPopover(currentSwatch, popover);

    popover.addEventListener("click", (e) => {
      const pickBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-pick-timer-color]");
      if (!pickBtn) return;
      const pickedColor = pickBtn.dataset.pickTimerColor ?? "";
      this.closeColorPopover();
      this.render();
      void this.api.updateTimerColor(timerId, pickedColor);
    });

    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      const liveSwatch = this.el.querySelector<HTMLElement>(
        `[data-toggle-timer-color="${timerId}"]`
      );
      if (popover.contains(t) || (liveSwatch && liveSwatch.contains(t))) return;
      this.closeColorPopover();
      this.render();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeColorPopover();
        this.render();
      }
    };

    const onReposition = () => {
      const liveSwatch = this.el.querySelector<HTMLElement>(
        `[data-toggle-timer-color="${timerId}"]`
      );
      if (!liveSwatch || !document.body.contains(liveSwatch)) {
        this.closeColorPopover();
        return;
      }
      this.positionColorPopover(liveSwatch, popover);
    };

    window.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReposition, { passive: true });
    window.addEventListener("scroll", onReposition, true);

    this.cleanupPopoverListeners = () => {
      window.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }

  private get allTimers(): DetectedTimer[] {
    const raw =
      this.store.detectedTimers.length > 0
        ? [...this.store.detectedTimers]
        : this.store.nodes
            .filter((p) => (p.assignedTimerId ?? p.gateId) > 0)
            .map((p) => ({
              timerId: p.assignedTimerId ?? p.gateId,
              timerLabel: p.timerLabel ?? "",
              color: p.color,
              isHub: (p.assignedTimerId ?? p.gateId) === 1,
              firmwareVersion: p.firmwareVersion ?? LATEST_FIRMWARE_VERSION,
              batteryMv: p.batteryMv,
              batteryPct: p.batteryPct,
              noiseFloorDbm: p.noiseFloorDbm,
              online: p.online,
              lastSeenAt: p.lastSeenAt,
            }));
    return raw.sort((a, b) => a.timerId - b.timerId);
  }

  private formatTitle(d: DetectedTimer): string {
    if (d.timerLabel && d.timerLabel.trim() !== "") {
      return `T${d.timerId} · ${d.timerLabel.trim()}`;
    }
    return `T${d.timerId}`;
  }

  private formatLastSeen(lastSeenAt?: string): string {
    if (!lastSeenAt) return "never";
    const parsedMs = Date.parse(lastSeenAt);
    if (!Number.isFinite(parsedMs) || parsedMs <= 0) return "never";
    const elapsedSec = Math.max(0, Math.floor((Date.now() - parsedMs) / 1000));
    if (elapsedSec < 1) return "<1s ago";
    if (elapsedSec < 60) return `${elapsedSec}s ago`;
    if (elapsedSec < 3600) {
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      return s > 0 ? `${m}m ${s}s ago` : `${m}m ago`;
    }
    const h = Math.floor(elapsedSec / 3600);
    const m = Math.floor((elapsedSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
  }

  private render(): void {
    const timers = this.allTimers;

    if (timers.length === 0) {
      this.el.innerHTML = renderEmpty(
        "No timers detected yet",
        "Power on your Hub timer (or enable the simulator) and discovered timers will appear here."
      );
      return;
    }

    const innerHtml = `
          <div class="timer-table-row timer-table-head">
            <span>Timer</span>
            <span>Status</span>
            <span>Role</span>
            <span>Firmware</span>
            <span>Noise floor</span>
            <span>Battery</span>
          </div>
          ${timers.map((d) => this.renderRow(d)).join("")}`;

    const existingTable = this.el.querySelector<HTMLElement>(".slot-table.timer-table");
    if (existingTable) {
      existingTable.innerHTML = innerHtml;
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll">
        <div class="slot-table timer-table">${innerHtml}
        </div>
      </div>`;
  }

  private renderRow(d: DetectedTimer): string {
    const title = this.formatTitle(d);
    const tone = d.batteryPct <= 20 ? "bad" : d.batteryPct <= 40 ? "warn" : "good";
    const color = timerColor(this.store, d.timerId);
    const isPickerOpen = this.colorPickerTimerId === d.timerId;
    const fwVer = d.firmwareVersion || LATEST_FIRMWARE_VERSION;
    const isLatestFw = fwVer === LATEST_FIRMWARE_VERSION;
    const profile = firmwareProfile(d.firmwareProfile);

    return `
      <div class="timer-table-row ${isPickerOpen ? "is-picker-open" : ""} ${d.online ? "" : "is-offline"}">
        <div class="detected-timer-id">
          <div class="gate-color-wrap">
            <button
              type="button"
              class="gate-color-swatch ${isPickerOpen ? "is-open" : ""}"
              data-toggle-timer-color="${d.timerId}"
              style="--c:${color}"
              title="Choose timer color"
              aria-label="Choose Timer ${d.timerId} color"
              aria-expanded="${isPickerOpen}"
            ></button>
          </div>
          <strong class="mono" title="${d.fingerprint ? `Board fingerprint ${esc(d.fingerprint)}` : ""}">${esc(title)}</strong>
        </div>

        <div>
          <span
            class="timer-status-pill ${d.online ? "is-online" : "is-offline"}"
            title="${d.lastSeenAt ? `Last check: ${esc(new Date(d.lastSeenAt).toLocaleTimeString())}` : "No timing frames received yet"}"
          >
            <span class="status-dot ${d.online ? "is-up" : ""}"></span>
            <span>${d.online ? "Online" : "Offline"}</span>
            <span class="timer-status-age">(${esc(this.formatLastSeen(d.lastSeenAt))})</span>
          </span>
        </div>

        <div>
          <span class="detected-role-pill ${d.isHub ? "is-hub" : ""}">${d.isHub ? "Hub" : "Spoke"}</span>
        </div>

        <div class="timer-fw-cell" title="${esc(`${profile.name} · ${fwVer}`)}">
          <span>${esc(profile.name)}</span>
          ${
            isLatestFw
              ? ""
              : `<span class="badge tone-warn" title="Reflash over USB on the Flasher page to update to ${LATEST_FIRMWARE_VERSION}">Update → ${LATEST_FIRMWARE_VERSION}</span>`
          }
        </div>

        <div class="mono muted">${d.online ? `${d.noiseFloorDbm.toFixed(0)} dBm` : "—"}</div>

        <div class="timer-battery-cell">
          <div class="meter timer-battery-meter"><span class="meter-fill tone-${tone}" style="width:${d.batteryPct}%"></span></div>
          <span class="mono timer-battery-text">${d.batteryPct}% · ${(d.batteryMv / 1000).toFixed(2)} V</span>
        </div>
      </div>`;
  }
}
