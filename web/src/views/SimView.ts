import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { FIRMWARE_RELEASES, LATEST_FIRMWARE_VERSION } from "../services/esp_flasher";
import { timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import {
  SimBatteryPack,
  SimPilotState,
  SimPilotStatus,
  SimState,
  SimTimerState,
  TrackNode,
} from "../types/models";
import { renderSectionCapsuleIcon } from "../widgets/markup";

interface PilotMotionState {
  progress: number;
  speedProgPerSec: number;
  status: SimPilotStatus;
  lastTickMs: number;
}

function statusMeta(p: SimPilotState): { label: string; badgeClass: string; hint: string } {
  const remainingSec = p.stateRemainingSec;
  const sec = remainingSec > 0 ? ` · ${Math.ceil(remainingSec)}s` : "";
  switch (p.status) {
    case "FLYING":
      return {
        label: "Flying",
        badgeClass: "sim-status-flying",
        hint: "On track racing through gates",
      };
    case "AVOIDING":
      return {
        label: "Flying High",
        badgeClass: "sim-status-avoiding",
        hint: "Cruising high above the course while someone is on the track — skips gate triggers",
      };
    case "CRASHED_VTX_ON":
      return {
        label: `Crashed · VTX On${sec}`,
        badgeClass: "sim-status-crashed-vtx",
        hint: "Step 1: Down on track near gate with 5.8 GHz VTX still transmitting while pilot assesses crash",
      };
    case "TURTLE_RECOVERY":
      return {
        label: `Turtle Recovering${sec}`,
        badgeClass: "sim-status-crashed-wait",
        hint: "Step 2: Spinning motors in Turtle Mode (Crash Flip) trying to flip the inverted quad upright",
      };
    case "TURTLE_FAILED":
      return {
        label: `Turtle Failed · Stayed Crashed${sec}`,
        badgeClass: "sim-status-crashed-vtx",
        hint: "Step 3: Turtle flip failed (prop stuck in grass/netting) — pilot disarms and switches VTX to Pit Mode",
      };
    case "CRASHED_WAITING_RECOVERY":
      return {
        label: "Crashed · Waiting for Lull",
        badgeClass: "sim-status-crashed-wait",
        hint: "Step 4: Quad stays crashed on the field (Pit Mode) until no pilots are flying — or click Walk recover to force an immediate track walk",
      };
    case "WALKING_RECOVERY":
      return {
        label: `Walking to Recover${sec}`,
        badgeClass: "sim-status-crashed-wait",
        hint: "Step 5: Pilot is walking out on the track to pick up the crashed quad and carry it back to the pit bench",
      };
    case "PIT_SWAP":
      if (p.batteryPct === 100) {
        return {
          label: `Launch Pad · Arming${sec}`,
          badgeClass: "sim-status-pit",
          hint: "Fresh 100% 6S pack plugged in on launch pad — arming and taking off when track is clear",
        };
      }
      return {
        label: `Pit · Pack Swap${sec}`,
        badgeClass: "sim-status-pit",
        hint: "Retrieving quad, unplugging spent LiPo, strapping fresh 6S pack at bench, and walking back to launch pad (30–60s)",
      };
    case "LAUNCH_HOLD":
      return {
        label:
          remainingSec > 0
            ? `Launch Hold · VTX Off (${Math.ceil(remainingSec)}s)`
            : "Launch Hold · Waiting for Lull",
        badgeClass: "sim-status-charging",
        hint: "Ready on launch pad with 100% LiPo plugged in — holding launch with VTX off (to prevent VTX overheating) so crashed pilot can recover",
      };
    case "CHARGING_WAIT":
      return {
        label: `Waiting for Charge${sec}`,
        badgeClass: "sim-status-charging",
        hint: "All 3 6S packs are depleted — waiting at the pit bench until a battery finishes charging to 100%",
      };
    case "PILOT_BREAK":
      return {
        label: `Taking a Break${sec}`,
        badgeClass: "sim-status-paused",
        hint: "Pilot decided to take a breather at the bench while batteries charge on the field charger",
      };
    case "PAUSED":
      return {
        label: "Paused in Pits",
        badgeClass: "sim-status-paused",
        hint: "Parked on pit bench with VTX off until launched",
      };
  }
}

function formatDroneTagText(p: SimPilotState): string {
  const sec = p.stateRemainingSec > 0 ? ` ${Math.ceil(p.stateRemainingSec)}s` : "";
  switch (p.status) {
    case "AVOIDING":
      return "HIGH";
    case "CRASHED_VTX_ON":
      return `CRASH${sec}`;
    case "TURTLE_RECOVERY":
      return `TURTLE${sec}`;
    case "TURTLE_FAILED":
      return "TURTLE FAIL";
    case "CRASHED_WAITING_RECOVERY":
      return "WAIT LULL";
    case "WALKING_RECOVERY":
      return `WALK${sec}`;
    default:
      return "";
  }
}

function isPilotInPits(status: SimPilotStatus): boolean {
  return (
    status === "PIT_SWAP" ||
    status === "LAUNCH_HOLD" ||
    status === "CHARGING_WAIT" ||
    status === "PILOT_BREAK" ||
    status === "PAUSED"
  );
}

function formatPilotVtxText(p: SimPilotState): string {
  if (p.vtxActive) {
    return "TX ON (25mW)";
  }
  if (p.status === "LAUNCH_HOLD") {
    return "Off (VTX Cool)";
  }
  return "Pit / Off";
}

function formatPackStateChip(pack: SimBatteryPack): { text: string; cls: string } {
  switch (pack.state) {
    case "IN_QUAD":
      return { text: "IN QUAD", cls: "is-in-quad" };
    case "READY":
      return { text: "READY", cls: "is-ready" };
    case "CHARGING":
      return { text: "CHG ⚡", cls: "is-charging" };
  }
}

function formatPackTone(pack: SimBatteryPack): string {
  if (pack.state === "CHARGING") return "warn";
  if (pack.pct <= 20) return "bad";
  if (pack.pct <= 45) return "warn";
  return "good";
}

function renderPilotPacksHtml(p: SimPilotState): string {
  const packs: SimBatteryPack[] =
    p.packs && p.packs.length === 3
      ? p.packs
      : [
          { packIndex: 1, pct: p.batteryPct, volts: p.batteryVolts, state: "IN_QUAD" },
          { packIndex: 2, pct: 100, volts: 25.2, state: "READY" },
          { packIndex: 3, pct: 64, volts: 23.7, state: "CHARGING" },
        ];
  return packs
    .map((pk) => {
      const chip = formatPackStateChip(pk);
      const tone = formatPackTone(pk);
      return `
        <div class="sim-pack-slot ${pk.state === "IN_QUAD" ? "is-active-pack" : ""}" data-pilot-pack-slot="${p.slotIndex}-${pk.packIndex}">
          <div class="sim-pack-head">
            <span class="sim-pack-title">Pack #${pk.packIndex}</span>
            <span class="sim-pack-chip ${chip.cls}" data-pilot-pack-chip="${p.slotIndex}-${pk.packIndex}">${chip.text}</span>
          </div>
          <div class="sim-pack-val mono" data-pilot-pack-val="${p.slotIndex}-${pk.packIndex}">
            <strong>${pk.pct}%</strong> · ${pk.volts.toFixed(1)}V
          </div>
          <div class="meter sim-pack-meter">
            <span class="meter-fill tone-${tone}" data-pilot-pack-bar="${p.slotIndex}-${pk.packIndex}" style="width:${Math.max(4, pk.pct)}%"></span>
          </div>
        </div>`;
    })
    .join("");
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
            <p>Live view of pilots moving through the track sections and pit bench. When someone walks onto the track to recover a quad, airborne pilots either return to the bench or fly high until the track is cleared.</p>
          </div>
          <div class="card card-flush" data-slot="course"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Pilots &amp; flight packs</h2>
            <p>Each pilot drains their 6S pack, lands in the pit area, unplugs the spent LiPo, walks back to the bench to strap on a fresh pack, sets the quad on the launch pad, plugs in, and takes off (30–60s turnaround).</p>
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
        const cmd = btn.dataset.cmd as
          | "crash"
          | "recover"
          | "walk-recover"
          | "pit"
          | "pause"
          | "launch"
          | "resume";
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

    const onTrackPilots = pilots.filter((p) => !isPilotInPits(p.status));
    const pitPilots = pilots.filter((p) => isPilotInPits(p.status));

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
          const isCrashedVtx =
            p.status === "CRASHED_VTX_ON" || p.status === "TURTLE_FAILED";
          const isCrashedWait =
            p.status === "TURTLE_RECOVERY" ||
            p.status === "CRASHED_WAITING_RECOVERY" ||
            p.status === "WALKING_RECOVERY";
          const tagText = formatDroneTagText(p);

          return `
            <div
              class="sim-drone-token ${isAvoiding ? "is-avoiding" : ""} ${isCrashedVtx ? "is-crashed-vtx" : ""} ${isCrashedWait ? "is-crashed-wait" : ""}"
              data-drone-token="${p.slotIndex}"
              style="left:${visualPct.toFixed(2)}%;--c:${esc(p.color)}"
            >
              <span class="sim-drone-dot"></span>
              <span class="sim-drone-callsign">${esc(p.callsign)}</span>
              ${
                tagText
                  ? `<span class="sim-drone-tag ${isCrashedVtx ? "is-bad" : isCrashedWait ? "is-warn" : ""}" data-drone-tag="${p.slotIndex}">${esc(tagText)}</span>`
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
              <div class="sim-pit-pill" style="--c:${esc(p.color)}">
                <span class="sim-drone-dot"></span>
                <span class="sim-drone-callsign">${esc(p.callsign)}</span>
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
                  ? `⚠ Person on track (${Math.ceil(walkerSec)}s left) — pilots have returned to the bench or are flying high until clear`
                  : `60 fps live course timeline · drones cross #1 → #${nodes.length} and wrap around ${nodes.length > 0 ? `S${nodes.length}` : "the loop"}`
              }
            </span>
            <div class="sim-course-actions">
              ${
                walkerActive
                  ? `<button class="btn btn-sm btn-danger-active" data-action="toggle-walker" title="End track walk recovery early and resume racing">
                      ${icons.pilot(14)}
                      <span data-walker-btn-label>Clear track (${Math.ceil(walkerSec)}s)</span>
                    </button>`
                  : ""
              }
              <button class="btn btn-sm btn-ghost" data-action="pack-burst" title="Bunch airborne pilots 150 ms apart approaching Gate #1">
                ${icons.zap(14)}<span>Pack burst</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="launch-all" title="Refill all 6S batteries to 100% and launch all enabled pilots">
                ${icons.play(14)}<span>Refill &amp; launch all</span>
              </button>
            </div>
          </div>

          <div class="gate-track-scroll sim-track-scroll">
            <div class="sim-altitude-lane-label ${walkerActive ? "is-walker-active" : ""}">
              <span>${walkerActive ? "PERSON ON TRACK · GATES PAUSED" : "ACTIVE FLIGHT CORRIDOR"}</span>
            </div>
            <div class="sim-flight-corridor ${walkerActive ? "is-walker-active" : ""}">
              <div class="sim-drone-track-layer">
                ${dronesHtml}
              </div>
            </div>

            <div class="gate-track-line sim-gate-track-line" role="list" aria-label="Simulated course gates">
              ${nodesHtml}
            </div>
          </div>

          <div class="sim-altitude-lane-label sim-pit-lane-label">
            <span>PIT BENCH &amp; BATTERY SWAP LANE (${pitPilots.length})</span>
          </div>
          <div class="gate-unassigned-tray sim-pit-tray">
            <div class="gate-unassigned-list sim-pit-list">
              ${pitTokensHtml}
            </div>
          </div>
        </div>`;
    } else {
      // Fast in-place update of countdowns without touching DOM structure
      const walkerLabel = this.el.querySelector<HTMLElement>("[data-walker-btn-label]");
      if (walkerLabel && walkerActive) {
        walkerLabel.textContent = `Clear track (${Math.ceil(walkerSec)}s)`;
      }
      const caption = this.el.querySelector<HTMLElement>("[data-course-caption]");
      if (caption && walkerActive) {
        caption.textContent = `⚠ Person on track (${Math.ceil(walkerSec)}s left) — pilots have returned to the bench or are flying high until clear`;
      }
      for (const p of onTrackPilots) {
        const tag = this.el.querySelector<HTMLElement>(`[data-drone-tag="${p.slotIndex}"]`);
        if (tag) {
          tag.textContent = formatDroneTagText(p);
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
          const meta = statusMeta(p);
          const tone = p.batteryPct <= 20 ? "bad" : p.batteryPct <= 45 ? "warn" : "good";
          const chBadge =
            p.channel > 0 ? `R${p.channel} · ${p.frequencyMhz} MHz` : "No channel";
          const isCrashed =
            p.status === "CRASHED_VTX_ON" ||
            p.status === "TURTLE_RECOVERY" ||
            p.status === "TURTLE_FAILED" ||
            p.status === "CRASHED_WAITING_RECOVERY" ||
            p.status === "WALKING_RECOVERY";
          const isParked = isPilotInPits(p.status);
          const isTurtleBusy =
            p.status === "TURTLE_RECOVERY" || p.status === "WALKING_RECOVERY";
          const isWalkingOut = p.status === "WALKING_RECOVERY";

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
                <div class="sim-packs-grid">
                  ${renderPilotPacksHtml(p)}
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
                    <div class="sim-stat-v ${p.vtxActive ? "tone-good" : "muted"}" data-pilot-vtx="${p.slotIndex}">${formatPilotVtxText(p)}</div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Nearest Gate</div>
                    <div class="sim-stat-v" data-pilot-loc="${p.slotIndex}">${p.status === "LAUNCH_HOLD" ? "Launch pad" : isParked ? "Pit bench" : esc(p.nearestGateLabel)}</div>
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
                    ? `<button class="btn btn-sm btn-armed" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="recover" ${isTurtleBusy ? "disabled" : ""} title="Attempt Turtle Mode recovery (spins motors for 3.5s to flip upright and resume flying)">
                        ${icons.play(13)}<span data-turtle-recover-label="${p.slotIndex}">${p.status === "TURTLE_RECOVERY" ? `Turtling (${Math.ceil(p.stateRemainingSec)}s)…` : "Turtle recover"}</span>
                      </button>
                      <button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="walk-recover" ${isWalkingOut ? "disabled" : ""} title="Force immediate track walk to retrieve the crashed quad — other drones will either land at the bench or fly high until clear">
                        ${icons.pilot(13)}<span data-walk-recover-label="${p.slotIndex}">${isWalkingOut ? `Walking out (${Math.ceil(p.stateRemainingSec)}s)…` : "Walk recover"}</span>
                      </button>`
                    : `<button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="crash" ${isParked ? "disabled" : ""} title="Force a mid-track crash near the closest gate (VTX stays on briefly)">
                        ${icons.zapOff(13)}<span>Force crash</span>
                      </button>`
                }
                <button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pit" ${p.status === "PIT_SWAP" || p.status === "CHARGING_WAIT" || isCrashed ? "disabled" : ""} title="Bring pilot into the pit bench to swap to a fresh 6S battery pack (30–60s)">
                  ${icons.reset(13)}<span>Swap battery</span>
                </button>
                ${
                  isParked
                    ? `<button class="btn btn-sm btn-armed" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="launch" title="Top up best pack to 100% and launch immediately from the starting line">
                        ${icons.play(13)}<span>Launch now</span>
                      </button>`
                    : !isCrashed
                    ? `<button class="btn btn-sm btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="break" title="Land in the pits and take a 60–90s break while batteries charge">
                        ${icons.pause(13)}<span>Take break</span>
                      </button>`
                    : ""
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
      const meta = statusMeta(p);
      const isParked = isPilotInPits(p.status);

      const badge = this.el.querySelector<HTMLElement>(`[data-pilot-badge="${p.slotIndex}"]`);
      if (badge) {
        badge.textContent = meta.label;
        badge.className = `sim-status-badge ${meta.badgeClass}`;
        badge.title = meta.hint;
      }
      for (const pk of p.packs ?? []) {
        const chip = formatPackStateChip(pk);
        const tone = formatPackTone(pk);
        const slotEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-slot="${p.slotIndex}-${pk.packIndex}"]`
        );
        if (slotEl) {
          slotEl.className = `sim-pack-slot ${pk.state === "IN_QUAD" ? "is-active-pack" : ""}`;
        }
        const chipEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-chip="${p.slotIndex}-${pk.packIndex}"]`
        );
        if (chipEl) {
          chipEl.textContent = chip.text;
          chipEl.className = `sim-pack-chip ${chip.cls}`;
        }
        const valEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-val="${p.slotIndex}-${pk.packIndex}"]`
        );
        if (valEl) {
          valEl.innerHTML = `<strong>${pk.pct}%</strong> · ${pk.volts.toFixed(1)}V`;
        }
        const barEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-bar="${p.slotIndex}-${pk.packIndex}"]`
        );
        if (barEl) {
          barEl.className = `meter-fill tone-${tone}`;
          barEl.style.width = `${Math.max(4, pk.pct)}%`;
        }
      }
      const speedEl = this.el.querySelector<HTMLElement>(`[data-pilot-speed="${p.slotIndex}"]`);
      if (speedEl) {
        speedEl.innerHTML = `${p.speedMph.toFixed(0)} <span class="unit">mph</span>`;
      }
      const altEl = this.el.querySelector<HTMLElement>(`[data-pilot-alt="${p.slotIndex}"]`);
      if (altEl) {
        altEl.innerHTML = `${p.altitudeMeters.toFixed(1)} <span class="unit">m</span>`;
      }
      const vtxEl = this.el.querySelector<HTMLElement>(`[data-pilot-vtx="${p.slotIndex}"]`);
      if (vtxEl) {
        vtxEl.textContent = formatPilotVtxText(p);
        vtxEl.className = `sim-stat-v ${p.vtxActive ? "tone-good" : "muted"}`;
      }
      const locEl = this.el.querySelector<HTMLElement>(`[data-pilot-loc="${p.slotIndex}"]`);
      if (locEl) {
        locEl.textContent =
          p.status === "LAUNCH_HOLD" ? "Launch pad" : isParked ? "Pit bench" : p.nearestGateLabel;
      }
      const packsEl = this.el.querySelector<HTMLElement>(`[data-pilot-packs="${p.slotIndex}"]`);
      if (packsEl) {
        packsEl.textContent = `#${p.packsFlown} · ${p.crashesCount} cr`;
      }
      const turtleLabelEl = this.el.querySelector<HTMLElement>(
        `[data-turtle-recover-label="${p.slotIndex}"]`
      );
      if (turtleLabelEl) {
        turtleLabelEl.textContent =
          p.status === "TURTLE_RECOVERY"
            ? `Turtling (${Math.ceil(p.stateRemainingSec)}s)…`
            : "Turtle recover";
      }
      const walkLabelEl = this.el.querySelector<HTMLElement>(
        `[data-walk-recover-label="${p.slotIndex}"]`
      );
      if (walkLabelEl) {
        walkLabelEl.textContent =
          p.status === "WALKING_RECOVERY"
            ? `Walking out (${Math.ceil(p.stateRemainingSec)}s)…`
            : "Walk recover";
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
