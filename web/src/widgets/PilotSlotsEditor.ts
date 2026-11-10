import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { PilotSlot } from "../types/models";

const RACEBAND_MHZ = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const DEFAULT_ENTER_THRESHOLD_DBM = -58;

/** Editable pilot / VTX channel table. Every field auto-saves on change. */
export class PilotSlotsEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("submit", this.handleSubmit);
    el.addEventListener("change", this.handleChange);
    el.addEventListener("keydown", this.handleKeyDown);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("submit", this.handleSubmit);
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("keydown", this.handleKeyDown);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(
      store.subscribe(["config"], () => {
        const active = document.activeElement;
        const editingText =
          active instanceof HTMLInputElement &&
          active.type !== "checkbox" &&
          this.el.contains(active);
        if (!editingText) this.render();
      })
    );
    this.render();
  }

  private render(): void {
    const enabledCount = this.store.enabledPilots.length;
    const usedChannels = new Map<number, string>();
    for (const p of this.store.pilots) {
      if (p.enabled && p.channel > 0) {
        usedChannels.set(p.channel, p.callsign);
      }
    }
    const innerHtml = `
          <div class="slot-row slot-head">
            <span>On (${enabledCount}/8)</span><span>Pilot</span><span>Channel</span><span>Enter threshold</span>
          </div>
          ${this.store.pilots.map((p) => this.renderRow(p, enabledCount, usedChannels)).join("")}`;

    const existingTable = this.el.querySelector<HTMLElement>(".slot-table");
    if (existingTable) {
      existingTable.innerHTML = innerHtml;
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll">
        <div class="slot-table">${innerHtml}
        </div>
      </div>
      <div class="rules-foot">
        <p class="note">Changes save automatically and sync to timers.</p>
        <button class="btn btn-ghost btn-sm" type="button" data-action="restore-default-pilots">Restore defaults</button>
      </div>`;
  }

  private renderRow(p: PilotSlot, enabledCount: number, usedChannels: Map<number, string>): string {
    const atLimit = !p.enabled && enabledCount >= 8;
    const needsChannel = p.enabled && p.channel === 0;
    const isCustomThreshold = Math.round(p.enterThreshold) !== DEFAULT_ENTER_THRESHOLD_DBM;
    const unassignedOpt = `<option value="0" ${p.channel === 0 ? "selected" : ""}>Select channel</option>`;
    const options =
      unassignedOpt +
      RACEBAND_MHZ.map((mhz, i) => {
        const ch = i + 1;
        const holder = usedChannels.get(ch);
        const takenByOther = holder !== undefined && holder !== p.callsign;
        const suffix = takenByOther ? ` (${esc(holder)})` : "";
        return `<option value="${ch}" ${p.channel === ch ? "selected" : ""}>R${ch} · ${mhz} MHz${suffix}</option>`;
      }).join("");
    return `
      <form class="slot-row ${p.enabled ? "" : "is-disabled"} ${needsChannel ? "is-unassigned-channel" : ""}" data-pilot="${p.slotIndex}">
        <label class="switch" title="${atLimit ? "Maximum 8 pilots can be enabled at a time" : `Enable slot ${p.slotIndex}`}">
          <input type="checkbox" name="enabled" ${p.enabled ? "checked" : ""} ${atLimit ? "disabled" : ""} />
          <span></span>
        </label>
        <div class="input-with-dot">
          <span class="dot" style="--c:${p.color}"></span>
          <input class="input" name="callsign" value="${esc(p.callsign)}" maxlength="16" autocomplete="off" />
        </div>
        <select class="input ${needsChannel ? "input-warn" : ""}" name="channel" title="${needsChannel ? "Assign a channel to this pilot" : ""}">${options}</select>
        <div class="input-suffix ${isCustomThreshold ? "has-reset" : ""}">
          <input class="input mono" type="number" name="threshold" value="${p.enterThreshold.toFixed(0)}" min="-90" max="-30" step="1" />
          <span>dBm</span>
          ${
            isCustomThreshold
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-threshold="${p.slotIndex}" title="Restore default threshold (${DEFAULT_ENTER_THRESHOLD_DBM} dBm)" aria-label="Restore default threshold (${DEFAULT_ENTER_THRESHOLD_DBM} dBm)">${icons.reset(13)}</button>`
              : ""
          }
        </div>
      </form>`;
  }

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const resetThreshBtn = target.closest<HTMLButtonElement>("[data-reset-threshold]");
    if (resetThreshBtn) {
      const slotIndex = Number(resetThreshBtn.dataset.resetThreshold);
      const current = this.store.pilot(slotIndex);
      if (current) {
        void this.api.updatePilotSlot({
          ...current,
          enterThreshold: DEFAULT_ENTER_THRESHOLD_DBM,
          exitThreshold: DEFAULT_ENTER_THRESHOLD_DBM - 10,
        });
      }
      return;
    }
    if (target.closest("[data-action=restore-default-pilots]")) {
      void this.api.resetPilotsToDefault();
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      target.blur();
    } else if (e.key === "Escape") {
      target.value = target.defaultValue;
      target.blur();
    }
  };

  private handleChange = (e: Event): void => {
    const form = (e.target as HTMLElement).closest("form");
    if (form) void this.save(form);
  };

  private handleSubmit = (e: Event): void => {
    e.preventDefault();
    void this.save(e.target as HTMLFormElement);
  };

  private async save(form: HTMLFormElement): Promise<void> {
    const slotIndex = Number(form.dataset.pilot);
    const current = this.store.pilot(slotIndex);
    if (!current) return;

    const data = new FormData(form);
    const channel = Number(data.get("channel"));
    const threshold = Number(data.get("threshold"));
    await this.api.updatePilotSlot({
      ...current,
      enabled: data.get("enabled") === "on",
      callsign: String(data.get("callsign") ?? "").trim() || `Pilot ${slotIndex}`,
      channel,
      frequencyMhz: channel >= 1 && channel <= 8 ? RACEBAND_MHZ[channel - 1] : 0,
      enterThreshold: threshold,
      exitThreshold: threshold - 10,
    });
  }
}
