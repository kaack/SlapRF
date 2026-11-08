import { Component } from "../core/component";
import { esc } from "../core/format";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { PilotSlot } from "../types/models";

const RACEBAND_MHZ = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];

/** Editable 8-slot pilot / VTX channel table. One <form> per slot. */
export class PilotSlotsEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("submit", this.handleSubmit);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("change", this.handleToggle);
    this.onDispose(() => {
      el.removeEventListener("submit", this.handleSubmit);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("change", this.handleToggle);
    });
    this.onDispose(store.subscribe(["config"], () => this.render()));
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
    this.el.innerHTML = `
      <div class="slot-table">
        <div class="slot-row slot-head">
          <span>On (${enabledCount}/8)</span><span>Pilot</span><span>Channel</span><span>Enter threshold</span><span></span>
        </div>
        ${this.store.pilots.map((p) => this.renderRow(p, enabledCount, usedChannels)).join("")}
      </div>`;
  }

  private renderRow(p: PilotSlot, enabledCount: number, usedChannels: Map<number, string>): string {
    const atLimit = !p.enabled && enabledCount >= 8;
    const needsChannel = p.enabled && p.channel === 0;
    const unassignedOpt = `<option value="0" ${p.channel === 0 ? "selected" : ""}>— Select channel —</option>`;
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
        <div class="input-suffix">
          <input class="input mono" type="number" name="threshold" value="${p.enterThreshold.toFixed(0)}" min="-90" max="-30" step="1" />
          <span>dBm</span>
        </div>
        <button class="btn btn-sm" type="submit" disabled>Save</button>
      </form>`;
  }

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    if (target.name === "enabled" || target.name === "channel") return;
    const form = target.closest("form");
    const button = form?.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) {
      button.disabled = false;
      button.classList.add("btn-primary");
    }
  };

  private handleToggle = (e: Event): void => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    if (target.name !== "enabled" && target.name !== "channel") return;
    const form = target.closest("form");
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
