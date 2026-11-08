import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { FIRMWARE_RELEASES, LATEST_FIRMWARE_VERSION } from "../services/esp_flasher";
import { timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { SimPilotState, SimPilotStatus, SimState, SimTimerState, TrackNode } from "../types/models";
import { renderSectionCapsuleIcon } from "../widgets/markup";

interface PilotMotionState {
  progress: number;
  speedProgPerSec: number;
  status: SimPilotStatus;
  lastTickMs: number;
}

function statusMeta(
  status: SimPilotStatus,
  remainingSec: number
): { label: string; badgeClass: string; hint: string } {
  const sec = remainingSec > 0 ? ` · ${Math.ceil(remainingSec)}s` : "";
  switch (status) {
    case "FLYING":
      return {
        label: "Flying",
        badgeClass: "sim-status-flying",
        hint: "On track at race altitude (1.3 m)",
      };
    case "AVOIDING":
      return {
        label: "Avoiding · 14m",
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
        label: "Crashed · Pit Mode",
        badgeClass: "sim-status-crashed-wait",
        hint: "Pit mode enabled (VTX off) — waiting for track walk recovery",
      };
    case "PIT_SWAP":
      return {
        label: `Pit · Swapping Pack${sec}`,
        badgeClass: "sim-status-pit",
        hint: "In pit lane with VTX off swapping to a fresh 6S LiPo pack",
      };
    case "PAUSED":
      return {
        label: "Paused in Pits",
        badgeClass: "sim-status-paused",
        hint: "Parked on pit bench with VTX off until launched",
      };
  }
}

export class SimView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private pollTimer: number | null = null;
  private rafId: number | null = null;
  private readonly motionBySlot = new Map<number, PilotMotionState>();

  private lastCourseStructSig = "";
  private lastPilotsStructSig = "";
  private lastTimersSig = "";

  private addRole: "spoke" | "hub" = "spoke";
  private addLabel = "";
  private addFwVersion = LATEST_FIRMWARE_VERSION;
  private errorMsg = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    const fwOptions = FIRMWARE_RELEASES.map(
      (fw) =>
        `<option value="${esc(fw.version)}" ${fw.version === this.addFwVersion ? "selected" : ""}>${esc(fw.label)}</option>`
    ).join("");

    // Uses the exact two-column `.settings` / `.settings-section` / `.card` UX language as System (`SetupView.ts`)
    el.innerHTML = `
      <div class="settings sim-settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Course &amp; pit lane</h2>
            <p>Live view of pilots moving through the track sections and pit bench. Send someone onto the track to recover quads (airborne pilots climb to 14 m to avoid them), trigger a pack burst, or refill and launch everyone.</p>
          </div>
          <div class="card card-flush" data-slot="course"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Pilots &amp; flight packs</h2>
            <p>Each pilot drains their 6S LiPo pack, finishes their lap at the start gate, pulls into the pit bench for ~20 seconds with VTX off to swap batteries, and launches back onto the course.</p>
          </div>
          <div class="sim-pilots-column" data-slot="pilots"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Simulated timers</h2>
            <p>Virtual XIAO ESP32-C5 timers feeding the simulation engine. Power individual timers off to test offline gate behavior, delete timers, or provision new ones (up to 6).</p>
          </div>
          <div class="card card-flush">
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
                  <span>Timer ID / name</span>
                  <input type="text" class="input mono" data-field="timer-label" placeholder="e.g. T5 Tunnel Exit" value="" />
                </label>
                <label class="sim-inline-field">
                  <span>Firmware version</span>
                  <select class="input mono" data-field="timer-fw">
                    ${fwOptions}
                  </select>
                </label>
              </div>
              <button class="btn btn-armed" data-action="timer-add" data-slot="timer-add-btn">
                + Add simulated timer
              </button>
            </div>
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
      if (this.rafId !== null) {
        window.cancelAnimationFrame(this.rafId);
      }
    });

    this.onDispose(store.subscribe(["status", "config"], () => this.render()));

    this.pollTimer = window.setInterval(() => {
      if (!document.hidden && this.store.simulatorRunning) {
        void this.api.pollStatusNow();
      }
    }, 250);

    this.render();
    this.startSmoothAnimationLoop();
  }

  private startSmoothAnimationLoop(): void {
    const tick = (nowMs: number) => {
      this.updateDronePositionsSmoothly(nowMs);
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private syncMotionFromSnapshot(pilots: SimPilotState[]): void {
    const nowMs = performance.now();
    const activeSlots = new Set<number>();

    for (const p of pilots) {
      if (!p.enabled || p.channel <= 0) continue;
      activeSlots.add(p.slotIndex);

      const baseRate =
        p.status === "FLYING" || p.status === "AVOIDING"
          ? (p.speedMph * 0.44704) / 360.0
          : 0;

      const existing = this.motionBySlot.get(p.slotIndex);
      if (!existing || existing.status !== p.status) {
        this.motionBySlot.set(p.slotIndex, {
          progress: p.trackProgress,
          speedProgPerSec: baseRate,
          status: p.status,
          lastTickMs: nowMs,
        });
        continue;
      }

      // Compute shortest circular difference on [0, 1)
      let err = p.trackProgress - existing.progress;
      if (err > 0.5) err -= 1.0;
      if (err < -0.5) err += 1.0;

      if (Math.abs(err) > 0.12 || baseRate === 0) {
        // Snap on large jumps (launch from pits, crash, or pack burst)
        existing.progress = p.trackProgress;
        existing.speedProgPerSec = baseRate;
      } else {
        // Gently blend velocity to converge without any visible hop
        existing.speedProgPerSec = Math.max(0.01, baseRate + err * 1.35);
      }
      existing.status = p.status;
      existing.lastTickMs = nowMs;
    }

    for (const slot of this.motionBySlot.keys()) {
      if (!activeSlots.has(slot)) {
        this.motionBySlot.delete(slot);
      }
    }
  }

  private updateDronePositionsSmoothly(nowMs: number): void {
    const numGates = Math.max(1, this.store.pucks.length);
    const gateZeroOffset = 0.5 / numGates;

    this.motionBySlot.forEach((m, slotIndex) => {
      const dtSec = Math.min(0.08, Math.max(0, (nowMs - m.lastTickMs) / 1000));
      m.lastTickMs = nowMs;

      if (m.status === "FLYING" || m.status === "AVOIDING") {
        m.progress = (m.progress + m.speedProgPerSec * dtSec) % 1.0;
        if (m.progress < 0) m.progress += 1.0;
      }

      const token = this.el.querySelector<HTMLElement>(
        `[data-drone-token="${slotIndex}"]`
      );
      if (token) {
        const visualPct = ((m.progress + gateZeroOffset) % 1.0) * 100;
        token.style.left = `${visualPct.toFixed(2)}%`;
      }
    });
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
            this.lastTimersSig = "";
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
    this.syncMotionFromSnapshot(simState?.pilots ?? []);
    this.renderCourse(simState);
    this.renderPilots(simState);
    this.renderTimers(simState);
  }

  private get orderedNodes(): TrackNode[] {
    return [...this.store.pucks].sort((a, b) => a.trackOrder - b.trackOrder);
  }

  private renderCourse(simState: SimState | null): void {
    const walkerActive = simState?.trackWalkerActive ?? false;
    const walkerSec = simState?.trackWalkerSecLeft ?? 0;
    const pilots = (simState?.pilots ?? []).filter((p) => p.enabled && p.channel > 0);
    const nodes = this.orderedNodes;
    const timersById = new Map<number, SimTimerState>(
      (simState?.timers ?? []).map((t) => [t.puckId, t])
    );

    const onTrackPilots = pilots.filter(
      (p) => p.status !== "PIT_SWAP" && p.status !== "PAUSED"
    );
    const pitPilots = pilots.filter(
      (p) => p.status === "PIT_SWAP" || p.status === "PAUSED"
    );

    const structSig = [
      walkerActive ? "W1" : "W0",
      nodes
        .map((n) => {
          const t = timersById.get(n.assignedPuckId);
          return `${n.puckId}:${n.assignedPuckId}:${n.name}:${n.role}:${t?.poweredOn ? 1 : 0}:${t?.color ?? ""}`;
        })
        .join(","),
      pilots.map((p) => `${p.slotIndex}:${p.callsign}:${p.color}:${p.status}`).join(","),
    ].join("|");

    if (structSig !== this.lastCourseStructSig) {
      this.lastCourseStructSig = structSig;
      const numGates = Math.max(1, nodes.length);
      const gateZeroOffset = 0.5 / numGates;

      const nodesHtml = nodes
        .map((node, index) => {
          const total = nodes.length;
          const isStart = node.role === "START_FINISH";
          const assignedId = node.assignedPuckId ?? 0;
          const hasTimer = assignedId > 0;
          const tiedTimer = timersById.get(assignedId);
          const powered = tiedTimer ? tiedTimer.poweredOn : false;
          const shortCode = hasTimer ? `T${assignedId}` : "—";
          const roleSub = hasTimer ? (tiedTimer?.isHub || assignedId === 1 ? "HUB" : "SPK") : "EMPTY";
          const color = hasTimer ? timerColor(this.store, assignedId) : "#64748b";

          const lastNode = nodes[(total - 1 + total) % total];
          const lastAssignedId = lastNode?.assignedPuckId ?? 0;
          const lastColor = lastAssignedId > 0 ? timerColor(this.store, lastAssignedId) : "#64748b";

          const nextNode = nodes[(index + 1) % total];
          const nextAssignedId = nextNode?.assignedPuckId ?? 0;
          const nextColor = nextAssignedId > 0 ? timerColor(this.store, nextAssignedId) : "#64748b";

          const displayName = node.name.trim() || `Gate ${index + 1}`;
          const sectionTag = `S${index + 1}`;
          const wrapSectionTag = `S${total}`;

          return `
            <div
              class="gate-line-item sim-gate-node ${isStart ? "is-start" : ""} ${hasTimer && powered ? "has-puck" : "is-empty-gate"}"
              style="--c:${color}"
            >
              <div class="gate-line-track-seg is-before ${powered ? "" : "is-dashed-seg"}"></div>
              <div class="gate-line-track-seg is-after ${powered ? "" : "is-dashed-seg"}"></div>

              <span
                class="gate-line-sec-pill is-leading sec-id-badge mono"
                style="--c1:${lastColor};--c2:${color}"
              >
                ${renderSectionCapsuleIcon(lastColor, color)}
                <span class="sec-pill-text">${wrapSectionTag}</span>
              </span>

              <span
                class="gate-line-sec-pill is-trailing sec-id-badge mono"
                style="--c1:${color};--c2:${nextColor}"
              >
                ${renderSectionCapsuleIcon(color, nextColor)}
                <span class="sec-pill-text">${sectionTag}</span>
              </span>

              <div class="gate-node-top">
                <span class="gate-node-order mono">#${index + 1}</span>
                ${
                  isStart
                    ? `<span class="gate-node-start-flag" title="Start / Finish gate">${icons.checkered(11)}</span>`
                    : ""
                }
              </div>

              <div class="gate-node-circle ${hasTimer && powered ? "" : "is-unassigned"}">
                <span class="gate-node-puck-code mono">${esc(shortCode)}</span>
                <span class="gate-node-puck-meta">
                  <span class="gate-node-status-dot ${powered ? "is-online" : ""}"></span>
                  <span>${powered ? roleSub : "OFF"}</span>
                </span>
              </div>

              <div class="gate-node-name">${esc(displayName)}</div>
            </div>`;
        })
        .join("");

      const dronesHtml = onTrackPilots
        .map((p) => {
          const m = this.motionBySlot.get(p.slotIndex);
          const prog = m ? m.progress : p.trackProgress;
          const visualPct = ((prog + gateZeroOffset) % 1.0) * 100;
          const isAvoiding = p.status === "AVOIDING";
          const isCrashedVtx = p.status === "CRASHED_VTX_ON";
          const isCrashedWait = p.status === "CRASHED_WAITING_RECOVERY";

          return `
            <div
              class="sim-drone-token ${isAvoiding ? "is-avoiding" : ""} ${isCrashedVtx ? "is-crashed-vtx" : ""} ${isCrashedWait ? "is-crashed-wait" : ""}"
              data-drone-token="${p.slotIndex}"
              style="left:${visualPct.toFixed(2)}%;--c:${esc(p.color)}"
            >
              <span class="sim-drone-dot"></span>
              <span class="sim-drone-callsign">${esc(p.callsign)}</span>
              ${
                isAvoiding
                  ? `<span class="sim-drone-tag">14m</span>`
                  : isCrashedVtx
                  ? `<span class="sim-drone-tag is-bad">VTX ON</span>`
                  : isCrashedWait
                  ? `<span class="sim-drone-tag is-warn">CRASH</span>`
                  : ""
              }
            </div>`;
        })
        .join("");

      const pitTokensHtml =
        pitPilots.length > 0
          ? pitPilots
              .map(
                (p) => `
              <div class="unassigned-puck-token sim-pit-pilot-token" style="--c:${esc(p.color)}">
                <span class="unassigned-puck-dot mono">R${p.channel}</span>
                <span class="unassigned-puck-info">
                  <span class="unassigned-puck-name">${esc(p.callsign)}</span>
                  <span class="unassigned-puck-sub" data-pit-sub="${p.slotIndex}">
                    ${
                      p.status === "PIT_SWAP"
                        ? `Swapping 6S pack · ${p.batteryPct}% (${Math.ceil(p.stateRemainingSec)}s)`
                        : `Paused on bench · ${p.batteryPct}%`
                    }
                  </span>
                </span>
                <button class="btn btn-sm btn-ghost sim-pit-launch-btn" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="launch" title="Launch onto course now">
                  ${icons.play(12)}<span>Launch</span>
                </button>
              </div>`
              )
              .join("")
          : `<span class="gate-unassigned-empty-chip">All active pilots are currently out on the track</span>`;

      this.slot("course").innerHTML = `
        <div class="gate-track-stage sim-course-stage">
          <div class="gate-track-header sim-course-toolbar">
            <span class="gate-track-caption" data-course-caption>
              ${
                walkerActive
                  ? `⚠ Person on track (${Math.ceil(walkerSec)}s left) — airborne drones holding 14 m altitude above gates`
                  : `60 fps live course timeline · drones cross #1 → #${nodes.length} and wrap around ${nodes.length > 0 ? `S${nodes.length}` : "the loop"}`
              }
            </span>
            <div class="sim-course-actions">
              <button class="btn btn-sm ${walkerActive ? "btn-danger-active" : "btn-ghost"}" data-action="toggle-walker">
                ${icons.pilot(14)}
                <span data-walker-btn-label>${
                  walkerActive
                    ? `Clear track (${Math.ceil(walkerSec)}s)`
                    : "Walk on track (recover quads)"
                }</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="pack-burst" title="Bunch airborne pilots 150 ms apart approaching Gate #1">
                ${icons.zap(14)}<span>Pack burst</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="launch-all" title="Refill all 6S batteries to 100% and launch all enabled pilots">
                ${icons.play(14)}<span>Refill &amp; launch all</span>
              </button>
            </div>
          </div>

          <div class="gate-track-scroll sim-track-scroll">
            <div class="sim-flight-corridor ${walkerActive ? "is-walker-active" : ""}">
              <div class="sim-altitude-lane-label">
                <span>${walkerActive ? "HIGH-ALTITUDE AVOIDANCE LANE (14 m · GATES SKIPPED)" : "ACTIVE FLIGHT CORRIDOR (1.3 m RACE ALTITUDE)"}</span>
              </div>
              <div class="sim-drone-track-layer">
                ${dronesHtml}
              </div>
            </div>

            <div class="gate-track-line sim-gate-track-line" role="list" aria-label="Simulated course gates">
              ${nodesHtml}
            </div>
          </div>

          <div class="gate-unassigned-tray sim-pit-tray">
            <div class="gate-unassigned-label">
              <span class="gate-unassigned-title">Pit bench &amp; battery swap lane (${pitPilots.length})</span>
              <span class="gate-unassigned-hint">Pilots land here with VTX off to swap 6S packs or wait while paused</span>
            </div>
            <div class="gate-unassigned-list">
              ${pitTokensHtml}
            </div>
          </div>
        </div>`;
    } else {
      // Fast in-place update of countdowns and pit bench percentages without touching DOM structure
      const walkerLabel = this.el.querySelector<HTMLElement>("[data-walker-btn-label]");
      if (walkerLabel) {
        walkerLabel.textContent = walkerActive
          ? `Clear track (${Math.ceil(walkerSec)}s)`
          : "Walk on track (recover quads)";
      }
      const caption = this.el.querySelector<HTMLElement>("[data-course-caption]");
      if (caption && walkerActive) {
        caption.textContent = `⚠ Person on track (${Math.ceil(walkerSec)}s left) — airborne drones holding 14 m altitude above gates`;
      }
      for (const p of pitPilots) {
        const sub = this.el.querySelector<HTMLElement>(`[data-pit-sub="${p.slotIndex}"]`);
        if (sub) {
          sub.textContent =
            p.status === "PIT_SWAP"
              ? `Swapping 6S pack · ${p.batteryPct}% (${Math.ceil(p.stateRemainingSec)}s)`
              : `Paused on bench · ${p.batteryPct}%`;
        }
      }
    }
  }

  private renderPilots(simState: SimState | null): void {
    const activePilots = (simState?.pilots ?? []).filter((p) => p.enabled);

    const structSig = activePilots
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.color}:${p.channel}:${p.status}`)
      .join("|");

    if (structSig !== this.lastPilotsStructSig) {
      this.lastPilotsStructSig = structSig;

      const cards = activePilots
        .map((p: SimPilotState) => {
          const meta = statusMeta(p.status, p.stateRemainingSec);
          const tone = p.batteryPct <= 20 ? "bad" : p.batteryPct <= 45 ? "warn" : "good";
          const chBadge =
            p.channel > 0 ? `R${p.channel} · ${p.frequencyMhz} MHz` : "No channel";
          const isCrashed =
            p.status === "CRASHED_VTX_ON" || p.status === "CRASHED_WAITING_RECOVERY";
          const isParked = p.status === "PIT_SWAP" || p.status === "PAUSED";

          return `
            <div class="card sim-pilot-card ${isCrashed ? "is-crashed" : ""}" data-pilot-card="${p.slotIndex}">
              <div class="sim-pilot-head">
                <div class="sim-pilot-id">
                  <span class="dot" style="--c:${esc(p.color)}"></span>
                  <span class="sim-pilot-name">${esc(p.callsign)}</span>
                  <span class="badge mono">${esc(chBadge)}</span>
                </div>
                <span class="sim-status-badge ${meta.badgeClass}" data-pilot-badge="${p.slotIndex}" title="${esc(meta.hint)}">${esc(meta.label)}</span>
              </div>

              <div class="sim-pilot-metrics">
                <div class="sim-batt-block">
                  <div class="sim-metric-label">
                    <span>6S LiPo Flight Pack</span>
                    <span class="mono" data-pilot-batt-text="${p.slotIndex}"><strong>${p.batteryPct}%</strong> · ${p.batteryVolts.toFixed(1)} V</span>
                  </div>
                  <div class="meter sim-batt-meter">
                    <span class="meter-fill tone-${tone}" data-pilot-batt-bar="${p.slotIndex}" style="width:${Math.max(4, p.batteryPct)}%"></span>
                  </div>
                </div>

                <div class="sim-telemetry-grid">
                  <div>
                    <div class="sim-stat-k">Speed</div>
                    <div class="sim-stat-v mono" data-pilot-speed="${p.slotIndex}">${p.speedMph.toFixed(0)} <span class="unit">mph</span></div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Altitude</div>
                    <div class="sim-stat-v mono" data-pilot-alt="${p.slotIndex}">${p.altitudeMeters.toFixed(1)} <span class="unit">m</span></div>
                  </div>
                  <div>
                    <div class="sim-stat-k">5.8 GHz VTX</div>
                    <div class="sim-stat-v ${p.vtxActive ? "tone-good" : "muted"}" data-pilot-vtx="${p.slotIndex}">${p.vtxActive ? "TX ON (25mW)" : "Pit / Off"}</div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Nearest Gate</div>
                    <div class="sim-stat-v" data-pilot-loc="${p.slotIndex}">${isParked ? "Pit bench" : esc(p.nearestGateLabel)}</div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Packs / Crashes</div>
                    <div class="sim-stat-v mono" data-pilot-packs="${p.slotIndex}">#${p.packsFlown} · ${p.crashesCount} cr</div>
                  </div>
                </div>
              </div>

              <div class="sim-pilot-controls">
                ${
                  isCrashed
                    ? `<button class="btn btn-sm btn-armed" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="recover" title="Flip quad over with turtle mode or recover and resume flying">
                        ${icons.play(13)}<span>Recover / Turtle</span>
                      </button>`
                    : `<button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="crash" ${isParked ? "disabled" : ""} title="Force a mid-track crash near the closest gate (VTX stays on briefly)">
                        ${icons.zapOff(13)}<span>Force crash</span>
                      </button>`
                }
                <button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pit" ${p.status === "PIT_SWAP" ? "disabled" : ""} title="Bring pilot into the pit bench to swap to a fresh 6S battery pack (~20s)">
                  ${icons.reset(13)}<span>Swap battery</span>
                </button>
                ${
                  isParked
                    ? `<button class="btn btn-sm btn-armed" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="launch" title="Launch immediately from the starting line with a fresh 100% pack">
                        ${icons.play(13)}<span>Launch now</span>
                      </button>`
                    : `<button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pause" title="Land and pause flight on the pit bench with VTX off">
                        ${icons.pause(13)}<span>Pause flight</span>
                      </button>`
                }
              </div>
            </div>`;
        })
        .join("");

      this.slot("pilots").innerHTML = `
        <div class="sim-pilots-grid">
          ${cards || `<div class="card empty-note">No enabled pilots — enable pilots on the System tab to simulate their flights.</div>`}
        </div>`;
      return;
    }

    // Update live telemetry numbers in-place without recreating pilot cards
    for (const p of activePilots) {
      const meta = statusMeta(p.status, p.stateRemainingSec);
      const tone = p.batteryPct <= 20 ? "bad" : p.batteryPct <= 45 ? "warn" : "good";
      const isParked = p.status === "PIT_SWAP" || p.status === "PAUSED";

      const badge = this.el.querySelector<HTMLElement>(`[data-pilot-badge="${p.slotIndex}"]`);
      if (badge) {
        badge.textContent = meta.label;
      }
      const battText = this.el.querySelector<HTMLElement>(`[data-pilot-batt-text="${p.slotIndex}"]`);
      if (battText) {
        battText.innerHTML = `<strong>${p.batteryPct}%</strong> · ${p.batteryVolts.toFixed(1)} V`;
      }
      const battBar = this.el.querySelector<HTMLElement>(`[data-pilot-batt-bar="${p.slotIndex}"]`);
      if (battBar) {
        battBar.className = `meter-fill tone-${tone}`;
        battBar.style.width = `${Math.max(4, p.batteryPct)}%`;
      }
      const speedEl = this.el.querySelector<HTMLElement>(`[data-pilot-speed="${p.slotIndex}"]`);
      if (speedEl) {
        speedEl.innerHTML = `${p.speedMph.toFixed(0)} <span class="unit">mph</span>`;
      }
      const altEl = this.el.querySelector<HTMLElement>(`[data-pilot-alt="${p.slotIndex}"]`);
      if (altEl) {
        altEl.innerHTML = `${p.altitudeMeters.toFixed(1)} <span class="unit">m</span>`;
      }
      const locEl = this.el.querySelector<HTMLElement>(`[data-pilot-loc="${p.slotIndex}"]`);
      if (locEl) {
        locEl.textContent = isParked ? "Pit bench" : p.nearestGateLabel;
      }
      const packsEl = this.el.querySelector<HTMLElement>(`[data-pilot-packs="${p.slotIndex}"]`);
      if (packsEl) {
        packsEl.textContent = `#${p.packsFlown} · ${p.crashesCount} cr`;
      }
    }
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

    // Matches `.slot-table.puck-table` / `.puck-table-row` from `TimersList.ts` in System
    const rows = timers
      .map((t: SimTimerState) => {
        const title = t.puckLabel ? `T${t.puckId} · ${t.puckLabel}` : `T${t.puckId}`;
        const color = timerColor(this.store, t.puckId);
        const isLatestFw = t.firmwareVersion === LATEST_FIRMWARE_VERSION;

        return `
          <div class="puck-table-row sim-puck-table-row ${t.poweredOn ? "" : "is-offline"}">
            <div class="detected-puck-id">
              <span class="gate-color-swatch" style="--c:${esc(color)};cursor:default"></span>
              <strong class="mono">${esc(title)}</strong>
            </div>

            <div>
              <span class="puck-status-pill ${t.poweredOn ? "is-online" : "is-offline"}">
                <span class="status-dot ${t.poweredOn ? "is-up" : ""}"></span>
                <span>${t.poweredOn ? "Powered on" : "Powered off"}</span>
              </span>
            </div>

            <div>
              <span class="detected-role-pill ${t.isHub ? "is-hub" : ""}">${t.isHub ? "Hub" : "Spoke"}</span>
            </div>

            <div class="puck-fw-cell">
              <span class="mono">${esc(t.firmwareVersion)}</span>
              ${
                isLatestFw
                  ? `<span class="badge tone-good">Latest</span>`
                  : `<span class="badge tone-warn">Update → ${LATEST_FIRMWARE_VERSION}</span>`
              }
            </div>

            <div>
              ${
                t.assignedGateName
                  ? `<span>${esc(t.assignedGateName)}</span>`
                  : `<span class="muted">Unassigned</span>`
              }
            </div>

            <div class="sim-timer-row-actions">
              <button class="btn btn-sm ${t.poweredOn ? "btn-ghost" : "btn-armed"}" data-action="timer-power" data-puck-id="${t.puckId}">
                ${t.poweredOn ? "Turn off" : "Turn on"}
              </button>
              <button class="btn btn-sm btn-ghost sim-btn-delete" data-action="timer-delete" data-puck-id="${t.puckId}" title="Delete simulated timer T${t.puckId}">
                Delete
              </button>
            </div>
          </div>`;
      })
      .join("");

    this.slot("timers-table").innerHTML = `
      ${this.errorMsg ? `<div class="sim-error-note">${esc(this.errorMsg)}</div>` : ""}
      <div class="slot-table puck-table">
        <div class="puck-table-row sim-puck-table-row puck-table-head">
          <span>Timer</span>
          <span>Power</span>
          <span>Role</span>
          <span>Firmware</span>
          <span>Assigned gate</span>
          <span class="num">Actions</span>
        </div>
        ${rows}
      </div>`;
  }
}
