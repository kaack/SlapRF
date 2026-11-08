import { Component } from "../core/component";
import { esc } from "../core/format";
import { ApiClient } from "../services/api_client";
import { LATEST_FIRMWARE_VERSION } from "../services/esp_flasher";
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

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    this.listen(el, "keydown", (e) => {
      if (e.key === "Escape" && this.colorPickerTimerId !== null) {
        this.colorPickerTimerId = null;
        this.render();
      }
    });

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const pickColorBtn = target.closest<HTMLElement>("[data-pick-puck-color]");
      if (pickColorBtn) {
        const timerId = Number(pickColorBtn.dataset.forPuck);
        const color = pickColorBtn.dataset.pickPuckColor ?? "";
        this.colorPickerTimerId = null;
        void this.api.updateTimerColor(timerId, color);
        return;
      }
      const toggleSwatch = target.closest<HTMLElement>("[data-toggle-puck-color]");
      if (toggleSwatch) {
        const timerId = Number(toggleSwatch.dataset.togglePuckColor);
        this.colorPickerTimerId = this.colorPickerTimerId === timerId ? null : timerId;
        this.render();
      }
    });

    const onDocClick = (e: MouseEvent) => {
      if (this.colorPickerTimerId === null) return;
      const target = e.target as HTMLElement | null;
      if (!target || !this.el.contains(target) || !target.closest(".gate-color-wrap")) {
        this.colorPickerTimerId = null;
        this.render();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    this.onDispose(() => document.removeEventListener("mousedown", onDocClick));

    this.onDispose(store.subscribe(["config", "status"], () => this.render()));
    this.render();
  }

  private get allTimers(): DetectedTimer[] {
    const raw =
      this.store.detectedPucks.length > 0
        ? [...this.store.detectedPucks]
        : this.store.pucks
            .filter((p) => (p.assignedPuckId ?? p.puckId) > 0)
            .map((p) => ({
              puckId: p.assignedPuckId ?? p.puckId,
              puckLabel: p.puckLabel ?? "",
              color: p.color,
              isHub: (p.assignedPuckId ?? p.puckId) === 1,
              firmwareVersion: p.firmwareVersion ?? LATEST_FIRMWARE_VERSION,
              batteryMv: p.batteryMv,
              batteryPct: p.batteryPct,
              noiseFloorDbm: p.noiseFloorDbm,
              online: p.online,
              lastSeenAt: p.lastSeenAt,
            }));
    return raw.sort((a, b) => a.puckId - b.puckId);
  }

  private formatTitle(d: DetectedTimer): string {
    if (d.puckLabel && d.puckLabel.trim() !== "") {
      return `T${d.puckId} · ${d.puckLabel.trim()}`;
    }
    return `T${d.puckId}`;
  }

  private render(): void {
    const timers = this.allTimers;

    if (timers.length === 0) {
      this.el.innerHTML = renderEmpty(
        "No timers detected yet",
        "Power on your Hub timer (or start the simulator below) and discovered timers will appear here."
      );
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll">
        <div class="slot-table puck-table">
          <div class="puck-table-row puck-table-head">
            <span>Timer</span>
            <span>Status</span>
            <span>Role</span>
            <span>Firmware</span>
            <span>Noise floor</span>
            <span>Battery</span>
          </div>
          ${timers.map((d) => this.renderRow(d)).join("")}
        </div>
      </div>`;
  }

  private renderRow(d: DetectedTimer): string {
    const title = this.formatTitle(d);
    const tone = d.batteryPct <= 20 ? "bad" : d.batteryPct <= 40 ? "warn" : "good";
    const color = timerColor(this.store, d.puckId);
    const isPickerOpen = this.colorPickerTimerId === d.puckId;
    const fwVer = d.firmwareVersion || LATEST_FIRMWARE_VERSION;
    const isLatestFw = fwVer === LATEST_FIRMWARE_VERSION;

    const popoverHtml = isPickerOpen
      ? `
        <div class="gate-color-popover" role="listbox" aria-label="Choose color for Timer ${d.puckId}">
          <div class="gate-color-popover-grid">
            ${TIMER_COLORS.map((c) => {
              const selected = c.toLowerCase() === color.toLowerCase();
              return `
                <button
                  type="button"
                  class="gate-color-option ${selected ? "is-selected" : ""}"
                  style="--c:${c}"
                  data-pick-puck-color="${c}"
                  data-for-puck="${d.puckId}"
                  title="${c}"
                  aria-label="Select color ${c}"
                  aria-selected="${selected}"
                ></button>`;
            }).join("")}
          </div>
        </div>`
      : "";

    return `
      <div class="puck-table-row ${isPickerOpen ? "is-picker-open" : ""} ${d.online ? "" : "is-offline"}">
        <div class="detected-puck-id">
          <div class="gate-color-wrap">
            <button
              type="button"
              class="gate-color-swatch ${isPickerOpen ? "is-open" : ""}"
              data-toggle-puck-color="${d.puckId}"
              style="--c:${color}"
              title="Choose timer color"
              aria-label="Choose Timer ${d.puckId} color"
              aria-expanded="${isPickerOpen}"
            ></button>
            ${popoverHtml}
          </div>
          <strong class="mono">${esc(title)}</strong>
        </div>

        <div>
          <span class="puck-status-pill ${d.online ? "is-online" : "is-offline"}">
            <span class="status-dot ${d.online ? "is-up" : ""}"></span>
            <span>${d.online ? "Online" : "Offline"}</span>
          </span>
        </div>

        <div>
          <span class="detected-role-pill ${d.isHub ? "is-hub" : ""}">${d.isHub ? "Hub" : "Spoke"}</span>
        </div>

        <div class="puck-fw-cell">
          <span class="mono">${esc(fwVer)}</span>
          ${
            isLatestFw
              ? `<span class="badge tone-good">Latest</span>`
              : `<span class="badge tone-warn" title="Flash ${LATEST_FIRMWARE_VERSION} over USB below">Update → ${LATEST_FIRMWARE_VERSION}</span>`
          }
        </div>

        <div class="mono muted">${d.online ? `${d.noiseFloorDbm.toFixed(0)} dBm` : "—"}</div>

        <div class="puck-battery-cell">
          <div class="meter puck-battery-meter"><span class="meter-fill tone-${tone}" style="width:${d.batteryPct}%"></span></div>
          <span class="mono puck-battery-text">${d.batteryPct}% · ${(d.batteryMv / 1000).toFixed(2)} V</span>
        </div>
      </div>`;
  }
}
