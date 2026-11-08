import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { FIRMWARE_RELEASES, LATEST_FIRMWARE_VERSION } from "../services/esp_flasher";
import { AppStore } from "../state/store";
import { SimPilotState, SimPilotStatus, SimState, SimTimerState } from "../types/models";

function statusMeta(
  status: SimPilotStatus,
  remainingSec: number
): { label: string; badgeClass: string; hint: string } {
  const sec = remainingSec > 0 ? ` (${Math.ceil(remainingSec)}s)` : "";
  switch (status) {
    case "FLYING":
      return {
        label: "Flying",
        badgeClass: "sim-status-flying",
        hint: "On track at race altitude (1.3 m)",
      };
    case "AVOIDING":
      return {
        label: "Avoiding · 14m Alt",
        badgeClass: "sim-status-avoiding",
        hint: "Flying high (14 m) to avoid person on track — skips gate triggers",
      };
    case "CRASHED_VTX_ON":
      return {
        label: `Crashed · VTX On${sec}`,
        badgeClass: "sim-status-crashed-vtx",
        hint: "Down on track near gate with 5.8 GHz VTX still transmitting",
      };
    case "CRASHED_WAITING_RECOVERY":
      return {
        label: "Crashed · Waiting Recovery",
        badgeClass: "sim-status-crashed-wait",
        hint: "Pit mode enabled (VTX off) — waiting for track walk recovery",
      };
    case "PIT_SWAP":
      return {
        label: `Pit · Swapping Pack${sec}`,
        badgeClass: "sim-status-pit",
        hint: "In pits with VTX off swapping to a fresh 6S LiPo pack",
      };
    case "PAUSED":
      return {
        label: "Paused in Pits",
        badgeClass: "sim-status-paused",
        hint: "Parked on bench with VTX off until launched",
      };
  }
}

export class SimView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private pollTimer: number | null = null;
  private addRole: "spoke" | "hub" = "spoke";
  private addLabel = "";
  private addFwVersion = LATEST_FIRMWARE_VERSION;
  private errorMsg = "";

  private lastTimersSig = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    const fwOptions = FIRMWARE_RELEASES.map(
      (fw) =>
        `<option value="${esc(fw.version)}" ${fw.version === this.addFwVersion ? "selected" : ""}>${esc(fw.label)}</option>`
    ).join("");

    el.innerHTML = `
      <div class="sim-view-stack">
        <section class="panel sim-course-panel" data-slot="course"></section>
        <section class="panel sim-pilots-panel" data-slot="pilots"></section>
        <section class="panel sim-timers-panel">
          <div data-slot="timers-table"></div>
          <div class="sim-timer-add-bar">
            <div class="sim-timer-add-fields">
              <label class="sim-inline-field">
                <span>Role</span>
                <select class="input" data-field="timer-role">
                  <option value="spoke" selected>Spoke · Sector Timer</option>
                  <option value="hub">Hub · Start Bridge</option>
                </select>
              </label>
              <label class="sim-inline-field">
                <span>Timer label</span>
                <input type="text" class="input" data-field="timer-label" placeholder="e.g. T5 Split-S Exit" value="" />
              </label>
              <label class="sim-inline-field">
                <span>Firmware</span>
                <select class="input" data-field="timer-fw">
                  ${fwOptions}
                </select>
              </label>
            </div>
            <button class="btn btn-armed" data-action="timer-add" data-slot="timer-add-btn">
              + Add simulated timer
            </button>
          </div>
        </section>
      </div>`;

    el.addEventListener("click", this.handleClick);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("change", this.handleChange);

    this.onDispose(() => {
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("change", this.handleChange);
      if (this.pollTimer !== null) {
        window.clearInterval(this.pollTimer);
      }
    });

    this.onDispose(store.subscribe(["status", "config"], () => this.render()));

    // Poll simulation status at ~3 Hz while SimView is open so track progress,
    // battery drain, and countdown timers animate smoothly.
    this.pollTimer = window.setInterval(() => {
      if (!document.hidden && this.store.simulatorRunning) {
        void this.api.pollStatusNow();
      }
    }, 350);

    this.render();
  }

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field === "timer-label") {
      this.addLabel = target.value;
    }
  };

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLSelectElement;
    if (target.dataset.field === "timer-role") {
      this.addRole = target.value === "hub" ? "hub" : "spoke";
    } else if (target.dataset.field === "timer-fw") {
      this.addFwVersion = target.value;
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
      case "toggle-walker": {
        const active = this.store.simState?.trackWalkerActive ?? false;
        void this.api.setTrackWalker(!active);
        break;
      }
      case "pack-burst":
        void this.api.simulatePack();
        break;
      case "launch-all": {
        const pilots = this.store.simState?.pilots ?? [];
        void (async () => {
          for (const p of pilots) {
            if (p.enabled && p.channel > 0) {
              await this.api.simPilotAction(p.slotIndex, "launch");
            }
          }
        })();
        break;
      }
      case "pilot-cmd": {
        const slotIndex = Number(btn.dataset.slot);
        const cmd = btn.dataset.cmd as "crash" | "recover" | "pit" | "pause" | "launch" | "resume";
        if (Number.isFinite(slotIndex) && cmd) {
          void this.api.simPilotAction(slotIndex, cmd);
        }
        break;
      }
      case "timer-power": {
        const puckId = Number(btn.dataset.puckId);
        if (Number.isFinite(puckId)) {
          this.errorMsg = "";
          void this.api.simTimerAction({ action: "toggle-power", puckId });
        }
        break;
      }
      case "timer-delete": {
        const puckId = Number(btn.dataset.puckId);
        if (Number.isFinite(puckId)) {
          this.errorMsg = "";
          void this.api.simTimerAction({ action: "delete", puckId }).catch((err: unknown) => {
            this.errorMsg = err instanceof Error ? err.message : String(err);
            this.renderTimers(this.store.simState);
          });
        }
        break;
      }
      case "timer-add": {
        this.errorMsg = "";
        const label = this.addLabel.trim();
        void this.api
          .simTimerAction({
            action: "add",
            role: this.addRole,
            label,
            firmwareVersion: this.addFwVersion,
          })
          .then(() => {
            this.addLabel = "";
            const input = this.el.querySelector<HTMLInputElement>('input[data-field="timer-label"]');
            if (input) input.value = "";
            this.lastTimersSig = "";
            this.renderTimers(this.store.simState);
          })
          .catch((err: unknown) => {
            this.errorMsg = err instanceof Error ? err.message : String(err);
            this.lastTimersSig = "";
            this.renderTimers(this.store.simState);
          });
        break;
      }
    }
  };

  private render(): void {
    const simState = this.store.simState;
    this.renderCourse(simState);
    this.renderPilots(simState);
    this.renderTimers(simState);
  }

  private renderCourse(simState: SimState | null): void {
    const walkerActive = simState?.trackWalkerActive ?? false;
    const walkerSec = simState?.trackWalkerSecLeft ?? 0;
    const pilots = (simState?.pilots ?? []).filter((p) => p.enabled && p.channel > 0);
    const pucks = this.store.pucks;
    const timersById = new Map<number, SimTimerState>(
      (simState?.timers ?? []).map((t) => [t.puckId, t])
    );

    // Build SVG track map with gates & live pilot markers
    const width = 760;
    const height = 230;
    const cx = width / 2;
    const cy = height / 2;
    const rx = 275;
    const ry = 76;

    const gateAngle = (idx: number, total: number): number => {
      if (total <= 0) return -Math.PI / 2;
      return -Math.PI / 2 + (idx / total) * Math.PI * 2;
    };

    const gatesSvg = pucks
      .map((g, idx) => {
        const ang = gateAngle(idx, pucks.length);
        const gx = cx + rx * Math.cos(ang);
        const gy = cy + ry * Math.sin(ang);
        const t = g.assignedPuckId ? timersById.get(g.assignedPuckId) : undefined;
        const powered = t ? t.poweredOn : false;
        const color = g.color || t?.color || "#38bdf8";
        const gateTitle = g.name || `Gate ${idx + 1}`;
        const timerBadge = g.assignedPuckId ? `T${g.assignedPuckId}` : "Unassigned";
        const labelY = Math.sin(ang) < 0 ? gy - 22 : gy + 28;
        return `
          <g class="sim-map-gate ${powered ? "is-powered" : "is-off"}">
            <circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="13" fill="var(--bg-elevated)" stroke="${powered ? esc(color) : "var(--border-strong)"}" stroke-width="${powered ? "2.5" : "1.5"}" ${powered ? "" : 'stroke-dasharray="3 3"'} />
            <text x="${gx.toFixed(1)}" y="${(gy + 4).toFixed(1)}" text-anchor="middle" class="sim-map-gate-id">${esc(timerBadge)}</text>
            <text x="${gx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" class="sim-map-gate-name">${esc(gateTitle)}</text>
          </g>`;
      })
      .join("");

    const pilotsSvg = pilots
      .map((p, idx) => {
        if (p.status === "PIT_SWAP" || p.status === "PAUSED") {
          const px = 54;
          const py = 46 + idx * 32;
          return `
            <g class="sim-map-pilot is-pit">
              <circle cx="${px}" cy="${py}" r="8" fill="${esc(p.color)}" opacity="0.55" />
              <text x="${px + 14}" y="${py + 4}" class="sim-map-pilot-label">${esc(p.callsign)} (${p.status === "PIT_SWAP" ? `${p.batteryPct}%⚡` : "Pit"})</text>
            </g>`;
        }
        const ang = -Math.PI / 2 + p.trackProgress * Math.PI * 2;
        const altOffset = p.status === "AVOIDING" ? 18 : 0;
        const px = cx + (rx + altOffset) * Math.cos(ang);
        const py = cy + (ry + altOffset * 0.5) * Math.sin(ang);
        const isCrashed = p.status === "CRASHED_VTX_ON" || p.status === "CRASHED_WAITING_RECOVERY";
        return `
          <g class="sim-map-pilot ${isCrashed ? "is-crashed" : ""}">
            ${
              p.status === "CRASHED_VTX_ON"
                ? `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="16" fill="none" stroke="#ef4444" stroke-width="1.8" stroke-dasharray="3 2" />`
                : p.status === "AVOIDING"
                ? `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="14" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="2 2" />`
                : ""
            }
            <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="8.5" fill="${esc(p.color)}" stroke="#0b0f17" stroke-width="2" />
            <text x="${px.toFixed(1)}" y="${(py - 13).toFixed(1)}" text-anchor="middle" class="sim-map-pilot-label">${esc(p.callsign)}${p.status === "AVOIDING" ? " · 14m" : isCrashed ? " ✕" : ""}</text>
          </g>`;
      })
      .join("");

    this.slot("course").innerHTML = `
      <div class="panel-head">
        <div>
          <div class="panel-title">Practice Field &amp; Track Loop</div>
          <div class="panel-sub">Simulate real practice gaps: battery pack swaps, mid-track crashes with lingering VTX RF, and people walking on the course</div>
        </div>
        <div class="sim-course-actions">
          <button class="btn ${walkerActive ? "btn-danger-active" : "btn-ghost"}" data-action="toggle-walker">
            ${icons.pilot(16)}
            <span>${
              walkerActive
                ? `Clear track (${Math.ceil(walkerSec)}s)`
                : "Walk on track (recover quads)"
            }</span>
          </button>
          <button class="btn btn-ghost" data-action="pack-burst" title="Bunch airborne pilots 150 ms apart approaching the Start Gate">
            ${icons.zap(16)}<span>Pack burst</span>
          </button>
          <button class="btn btn-ghost" data-action="launch-all" title="Refill all 6S batteries to 100% and launch all enabled pilots">
            ${icons.play(16)}<span>Refill &amp; launch all</span>
          </button>
        </div>
      </div>
      ${
        walkerActive
          ? `<div class="sim-walker-banner">
              <strong>Person on track (quad recovery in progress · ${Math.ceil(walkerSec)}s left):</strong>
              Airborne pilots have climbed to <strong>14 m altitude</strong> to avoid the person on the field (gates will not trigger), and crashed quads have been carried back to the pits.
            </div>`
          : ""
      }
      <div class="sim-track-canvas-wrap">
        <svg viewBox="0 0 ${width} ${height}" class="sim-track-svg" role="img" aria-label="Simulated practice track loop">
          <rect x="14" y="18" width="136" height="${height - 36}" rx="10" fill="rgba(15, 23, 42, 0.55)" stroke="var(--border-subtle)" stroke-dasharray="4 4" />
          <text x="26" y="34" class="sim-map-zone-title">PIT LANE / BENCH</text>
          <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="var(--border-strong)" stroke-width="8" opacity="0.35" />
          <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 6" opacity="0.55" />
          ${
            walkerActive
              ? `<text x="${cx}" y="${cy + 5}" text-anchor="middle" class="sim-map-walker-alert">⚠ PERSON ON TRACK · PILOTS AT 14m ALTITUDE</text>`
              : `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="sim-map-center-note">360 m loop · CCW race direction</text>`
          }
          ${gatesSvg}
          ${pilotsSvg}
        </svg>
      </div>`;
  }

  private renderPilots(simState: SimState | null): void {
    const allPilots = simState?.pilots ?? [];
    const activePilots = allPilots.filter((p) => p.enabled);

    const rows = activePilots
      .map((p: SimPilotState) => {
        const meta = statusMeta(p.status, p.stateRemainingSec);
        const battTone =
          p.batteryPct <= 20 ? "is-low" : p.batteryPct <= 45 ? "is-mid" : "is-good";
        const chBadge =
          p.channel > 0 ? `R${p.channel} · ${p.frequencyMhz} MHz` : "No channel assigned";
        const isCrashed =
          p.status === "CRASHED_VTX_ON" || p.status === "CRASHED_WAITING_RECOVERY";
        const isParked = p.status === "PIT_SWAP" || p.status === "PAUSED";

        return `
          <div class="sim-pilot-card ${isCrashed ? "is-crashed" : ""}">
            <div class="sim-pilot-head">
              <div class="sim-pilot-id">
                <span class="pilot-dot" style="background:${esc(p.color)}"></span>
                <span class="sim-pilot-name">${esc(p.callsign)}</span>
                <span class="badge mono">${esc(chBadge)}</span>
              </div>
              <span class="sim-status-badge ${meta.badgeClass}" title="${esc(meta.hint)}">${esc(meta.label)}</span>
            </div>

            <div class="sim-pilot-metrics">
              <div class="sim-batt-block">
                <div class="sim-metric-label">
                  <span>6S LiPo Pack</span>
                  <span class="mono"><strong>${p.batteryPct}%</strong> · ${p.batteryVolts.toFixed(1)} V</span>
                </div>
                <div class="sim-batt-bar">
                  <div class="sim-batt-fill ${battTone}" style="width:${Math.max(4, p.batteryPct)}%"></div>
                </div>
              </div>

              <div class="sim-telemetry-grid">
                <div>
                  <div class="sim-stat-k">Speed</div>
                  <div class="sim-stat-v mono">${p.speedMph.toFixed(0)} <span class="unit">mph</span></div>
                </div>
                <div>
                  <div class="sim-stat-k">Altitude</div>
                  <div class="sim-stat-v mono">${p.altitudeMeters.toFixed(1)} <span class="unit">m</span></div>
                </div>
                <div>
                  <div class="sim-stat-k">5.8 GHz VTX</div>
                  <div class="sim-stat-v ${p.vtxActive ? "tone-good" : "muted"}">${p.vtxActive ? "TX ON (25mW)" : "Pit / Off"}</div>
                </div>
                <div>
                  <div class="sim-stat-k">Location</div>
                  <div class="sim-stat-v">${isParked ? "Pit bench" : esc(p.nearestGateLabel)}</div>
                </div>
                <div>
                  <div class="sim-stat-k">Packs / Crashes</div>
                  <div class="sim-stat-v mono">#${p.packsFlown} · ${p.crashesCount} cr</div>
                </div>
              </div>
            </div>

            <div class="sim-pilot-controls">
              ${
                isCrashed
                  ? `<button class="btn btn-sm btn-armed" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="recover" title="Flip quad over with turtle mode or recover and resume flying">
                      ${icons.play(14)}<span>Recover / Turtle</span>
                    </button>`
                  : `<button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="crash" ${isParked ? "disabled" : ""} title="Force a mid-track crash near the closest gate (VTX stays on briefly)">
                      ${icons.zapOff(14)}<span>Force crash</span>
                    </button>`
              }
              <button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pit" ${p.status === "PIT_SWAP" ? "disabled" : ""} title="Bring pilot into the pits to swap to a fresh 6S battery pack (~20s)">
                ${icons.reset(14)}<span>Swap battery</span>
              </button>
              ${
                isParked
                  ? `<button class="btn btn-sm btn-armed" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="launch" title="Launch immediately from the starting line with a fresh 100% pack">
                      ${icons.play(14)}<span>Launch now</span>
                    </button>`
                  : `<button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pause" title="Land and pause flight in the pits with VTX off">
                      ${icons.pause(14)}<span>Pause flight</span>
                    </button>`
              }
            </div>
          </div>`;
      })
      .join("");

    this.slot("pilots").innerHTML = `
      <div class="panel-head">
        <div>
          <div class="panel-title">Simulated Pilots &amp; Flight Packs</div>
          <div class="panel-sub">Pilots automatically drain their 6S packs, finish their current lap, pull into the pits for ~20s to swap batteries, and launch back on track</div>
        </div>
      </div>
      <div class="sim-pilots-grid">
        ${rows || `<div class="empty-note">No enabled pilots — enable pilots on the System tab to simulate their flights.</div>`}
      </div>`;
  }

  private renderTimers(simState: SimState | null): void {
    const timers = simState?.timers ?? [];
    const canAdd = timers.length < 6;
    const sig =
      timers
        .map(
          (t) =>
            `${t.puckId}:${t.puckLabel}:${t.color}:${t.isHub ? 1 : 0}:${t.firmwareVersion}:${t.poweredOn ? 1 : 0}:${t.assignedGateName}`
        )
        .join("|") + `|err:${this.errorMsg}`;
    if (sig === this.lastTimersSig) return;
    this.lastTimersSig = sig;

    const addBtn = this.slot("timer-add-btn") as HTMLButtonElement;
    if (addBtn) addBtn.disabled = !canAdd;

    const rows = timers
      .map((t: SimTimerState) => {
        return `
          <tr>
            <td>
              <div class="sim-timer-id-cell">
                <span class="pilot-dot" style="background:${esc(t.color)}"></span>
                <span class="badge mono">T${t.puckId}</span>
                <strong>${esc(t.puckLabel)}</strong>
              </div>
            </td>
            <td>
              <span class="badge ${t.isHub ? "badge-hub" : "badge-spoke"}">${
                t.isHub ? "Hub · Start Bridge" : "Spoke · Sector"
              }</span>
            </td>
            <td class="mono">${esc(t.firmwareVersion)}</td>
            <td>${
              t.assignedGateName
                ? `<strong>${esc(t.assignedGateName)}</strong>`
                : `<span class="muted">Unassigned (assign in System → Track)</span>`
            }</td>
            <td>
              <span class="status-pill ${t.poweredOn ? "is-up" : "is-down"}">
                <span class="status-dot ${t.poweredOn ? "is-up" : ""}"></span>
                ${t.poweredOn ? "Powered On · 50 Hz" : "Powered Off"}
              </span>
            </td>
            <td class="num">
              <div class="sim-timer-row-actions">
                <button class="btn btn-sm ${t.poweredOn ? "btn-ghost" : "btn-armed"}" data-action="timer-power" data-puck-id="${t.puckId}">
                  ${t.poweredOn ? "Turn off" : "Turn on"}
                </button>
                <button class="btn btn-sm btn-ghost sim-btn-delete" data-action="timer-delete" data-puck-id="${t.puckId}" title="Delete simulated timer T${t.puckId}">
                  Delete
                </button>
              </div>
            </td>
          </tr>`;
      })
      .join("");

    this.slot("timers-table").innerHTML = `
      <div class="panel-head">
        <div>
          <div class="panel-title">Simulated Hardware Timers (${timers.length} / 6)</div>
          <div class="panel-sub">Power off individual XIAO ESP32-C5 timers to test offline gate behavior, delete timers, or provision new simulated timers</div>
        </div>
      </div>
      ${this.errorMsg ? `<div class="sim-error-note">${esc(this.errorMsg)}</div>` : ""}
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Timer</th>
              <th>Role</th>
              <th>Firmware</th>
              <th>Assigned Track Gate</th>
              <th>Power &amp; Telemetry</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              `<tr><td colspan="6" class="muted">No simulated timers — add one below.</td></tr>`
            }
          </tbody>
        </table>
      </div>`;
  }
}
