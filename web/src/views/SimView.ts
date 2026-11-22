import { Component } from "../core/component";
import { openCustomSelect } from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { adaptColorForTheme, getAppTheme } from "../core/theme";
import {
  formatBandChannelWithFreq,
  isValidEncodedSeatChannel,
  renderMultiBandSelectOptionsHtml,
} from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import { formatMultiGPScoring, sharedMultiGPService } from "../services/multigp_service";
import { isSimulatedSerialPort } from "../services/sim_serial_port";
import { usbPool } from "../services/timer_console";
import { timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import {
  isLapRFMode,
  isRotorHazardMode,
  MultiGPRaceViewData,
  SimBatteryPack,
  SimLapRFUnit,
  SimMultiGPAdminAction,
  SimMultiGPState,
  SimPilotState,
  SimPilotStatus,
  SimRotorHazardUnit,
  SimState,
  SimTimerState,
  TrackNode,
} from "../types/models";
import { renderSectionCapsuleIcon } from "../widgets/markup";

interface PilotMotionState {
  progress: number;
  serverProgress: number;
  serverPerfMs: number;
  baseRate: number;
  status: SimPilotStatus;
  lastTickMs: number;
}

function wrapUnit01(v: number): number {
  const m = v % 1.0;
  return m < 0 ? m + 1.0 : m;
}

function setTextIfChanged(el: HTMLElement | null, next: string): void {
  if (el && el.textContent !== next) {
    el.textContent = next;
  }
}

function setHtmlIfChanged(el: HTMLElement | null, next: string): void {
  if (el && el.innerHTML !== next) {
    el.innerHTML = next;
  }
}

function setClassIfChanged(el: HTMLElement | null, next: string): void {
  if (el && el.className !== next) {
    el.className = next;
  }
}

function statusMeta(p: SimPilotState): { label: string; badgeClass: string; hint: string } {
  const remainingSec = p.stateRemainingSec;
  const sec = remainingSec > 0 ? ` · ${Math.ceil(remainingSec)}s` : "";
  switch (p.status) {
    case "FLYING":
      return {
        label: "Flying",
        badgeClass: "sim-status-flying",
        hint: "On track racing past timers",
      };
    case "AVOIDING":
      return {
        label: "Flying High",
        badgeClass: "sim-status-avoiding",
        hint: "Circling high above the course while a person is on the track",
      };
    case "LANDING":
      return {
        label: `Landing${sec}`,
        badgeClass: "sim-status-pit",
        hint: "Heading back to the pit area and descending to land (5s) before disarming",
      };
    case "CRASHED_VTX_ON":
      return {
        label: `Crashed · VTX On${sec}`,
        badgeClass: "sim-status-crashed-vtx",
        hint: "Step 1: Down on track near timer with 5.8 GHz VTX still transmitting while pilot assesses crash",
      };
    case "TURTLE_RECOVERY":
      return {
        label: `Turtling${sec}`,
        badgeClass: "sim-status-crashed-wait",
        hint: "Step 2: Spinning motors in Turtle Mode (Crash Flip) trying to flip the inverted quad upright",
      };
    case "TURTLE_FAILED":
      return {
        label: `Turtle Failed${sec}`,
        badgeClass: "sim-status-crashed-vtx",
        hint: "Step 3: Turtle flip failed (prop stuck in grass/netting); pilot disarms and switches VTX to Pit Mode",
      };
    case "CRASHED_WAITING_RECOVERY":
      return {
        label: "Wait for Lull",
        badgeClass: "sim-status-crashed-wait",
        hint: "Step 4: Quad stays crashed on the field (Pit Mode) until no pilots are flying, or click Walk recover to force an immediate track walk",
      };
    case "WALKING_RECOVERY":
      return {
        label: `Walking Out${sec}`,
        badgeClass: "sim-status-crashed-wait",
        hint: "Step 5: Pilot is walking out onto the track to retrieve the crashed quad and return to the bench (30–60s)",
      };
    case "PIT_SWAP":
      if (p.batteryPct === 100) {
        return {
          label: `Arming${sec}`,
          badgeClass: "sim-status-pit",
          hint: "Fresh 100% 6S pack plugged in on launch pad; arming and taking off when track is clear",
        };
      }
      return {
        label: `Pack Swap${sec}`,
        badgeClass: "sim-status-pit",
        hint: "Retrieving quad, unplugging spent LiPo, strapping fresh 6S pack at bench, and walking back to launch pad (30–60s)",
      };
    case "LAUNCH_HOLD":
      return {
        label: `Launch Hold${sec}`,
        badgeClass: "sim-status-charging",
        hint: "Ready on launch pad with 100% LiPo plugged in; holding launch with VTX off so crashed pilot can recover",
      };
    case "CHARGING_WAIT":
      return {
        label: `Charging${sec}`,
        badgeClass: "sim-status-charging",
        hint: "All 3 6S packs depleted; waiting at the pit bench until a battery finishes charging to 100%",
      };
    case "PILOT_BREAK":
      return {
        label: `On Break${sec}`,
        badgeClass: "sim-status-paused",
        hint: "Pilot decided to take a breather at the bench while batteries charge on the field charger",
      };
    case "PAUSED":
      return {
        label: "Paused",
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
    case "LANDING":
      return `LAND${sec}`;
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

function formatPackStateChip(pack: SimBatteryPack): { html: string; cls: string } {
  switch (pack.state) {
    case "IN_QUAD":
      return { html: `<span>PLG</span>${icons.plug(10)}`, cls: "is-in-quad" };
    case "READY":
      return { html: `<span>READY</span>`, cls: "is-ready" };
    case "CHARGING":
      return { html: `<span>CHG</span>${icons.zap(10)}`, cls: "is-charging" };
  }
}

function formatPackTone(pack: SimBatteryPack): string {
  if (pack.pct <= 25) return "bad";
  if (pack.pct < 80) return "warn";
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
            <span class="sim-pack-chip ${chip.cls}" data-pilot-pack-chip="${p.slotIndex}-${pk.packIndex}">${chip.html}</span>
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

const SIM_VIEW_STORAGE_KEY = "slaprf.ui.sim_view.v1";

export class SimView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private isViewActive = true;
  private pollTimer: number | null = null;
  private rafId: number | null = null;
  private readonly motionBySlot = new Map<number, PilotMotionState>();
  private trackLayerEl: HTMLElement | null = null;
  private trackLayerWidth = 0;
  private trackResizeObs: ResizeObserver | null = null;
  private readonly droneTokensBySlot = new Map<number, HTMLElement>();

  private lastCourseStructSig = "";
  private lastPilotsStructSig = "";
  private lastTimersSig = "";
  private lastMultiGPSig = "";

  private addRole: "spoke" | "hub" = "spoke";
  private addLabel = "";
  private errorMsg = "";

  private mgpNewName = "";
  private mgpNewMode: "controlled" | "zippyq" = "controlled";
  private mgpNewScoring = 0;
  private mgpRevealKey = false;
  private mgpCopiedKey = false;
  private mgpErrorMsg = "";
  private readonly expandedMgpRaceIds = new Set<number>();
  private readonly mgpWalkupByRace = new Map<number, string>();
  private readonly mgpSelectedRoundByRace = new Map<number, number>();
  private readonly mgpSelectedHeatByRace = new Map<number, number>();
  private mgpDragPayload: {
    raceId: number;
    pilotId?: number;
    fromRound?: number;
    fromHeat?: number;
    fromSeatIndex?: number;
  } | null = null;
  private readonly mgpRailScrollByKey = new Map<string, number>();
  private mgpPendingScrollBottomKey = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    try {
      const raw = window.localStorage.getItem(SIM_VIEW_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          addRole?: "spoke" | "hub";
          addLabel?: string;
        };
        if (parsed.addRole === "spoke" || parsed.addRole === "hub") {
          this.addRole = parsed.addRole;
        }
        if (typeof parsed.addLabel === "string") {
          this.addLabel = parsed.addLabel;
        }
      }
    } catch {
      // Ignore storage access errors
    }

    // Uses the exact two-column `.settings` / `.settings-section` / `.card` UX language as System (`SetupView.ts`)
    el.innerHTML = `
      <div class="settings sim-settings">
        <section class="settings-section" data-section-anchor="course">
          <div class="settings-intro">
            <h2>Course &amp; pit lane</h2>
            <p>Live view of simulated pilots on the track and in the pits. During a track walk, airborne pilots either land or circle high until the track is clear.</p>
          </div>
          <div class="card card-flush" data-slot="course"></div>
        </section>

        <section class="settings-section" data-section-anchor="pilots">
          <div class="settings-intro">
            <h2>Pilots &amp; flight packs</h2>
            <p>Pilots fly until their 6S pack drains, land in the pits, swap to a charged pack at the bench (30–60s turnaround), and relaunch.</p>
          </div>
          <div class="sim-pilots-column" data-slot="pilots"></div>
        </section>

        <section class="settings-section" data-section-anchor="boards">
          <div class="settings-intro">
            <h2 data-slot="boards-title">Simulated boards</h2>
            <p data-slot="boards-desc">Virtual Seeed XIAO ESP32-C5 boards (Board #1..#7). Each board's role (Hub, Spoke, or Unflashed), ID, and firmware depend on what it has been flashed with in the Flasher. Power boards on or off, add blank boards, or restore defaults.</p>
          </div>
          <div class="card card-flush">
            <div data-slot="timers-table"></div>
            <div class="rules-foot">
              <p class="note" data-slot="boards-foot-note">Connect any powered-on board over USB in the Flasher to flash or erase its firmware.</p>
              <div style="display:flex;gap:8px;align-items:center">
                <button class="btn btn-ghost btn-sm" type="button" data-action="timer-reset-defaults">Restore defaults</button>
                <button class="btn btn-ghost btn-sm" type="button" data-action="timer-add" data-slot="timer-add-btn">
                  + Add blank board
                </button>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" data-section-anchor="multigp">
          <div class="settings-intro">
            <h2>Simulated MultiGP</h2>
            <p>Built-in MultiGP WebService server for testing chapter API keys, race imports, ZippyQ round queues, and result uploads without a multigp.com account.</p>
          </div>
          <div class="settings-cards" data-slot="multigp"></div>
        </section>
      </div>`;

    el.addEventListener("click", this.handleClick);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("change", this.handleChange);
    el.addEventListener("keydown", this.handleKeyDown);
    el.addEventListener("dragstart", this.handleDragStart);
    el.addEventListener("dragover", this.handleDragOver);
    el.addEventListener("dragleave", this.handleDragLeave);
    el.addEventListener("dragdrop", this.handleDrop);
    el.addEventListener("drop", this.handleDrop);
    el.addEventListener("dragend", this.handleDragEnd);
    el.addEventListener("scroll", this.handleScrollCapture, true);

    this.onDispose(() => {
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("keydown", this.handleKeyDown);
      el.removeEventListener("dragstart", this.handleDragStart);
      el.removeEventListener("dragover", this.handleDragOver);
      el.removeEventListener("dragleave", this.handleDragLeave);
      el.removeEventListener("dragdrop", this.handleDrop);
      el.removeEventListener("drop", this.handleDrop);
      el.removeEventListener("dragend", this.handleDragEnd);
      el.removeEventListener("scroll", this.handleScrollCapture, true);
      if (this.pollTimer !== null) {
        window.clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.rafId !== null) {
        window.cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.trackResizeObs?.disconnect();
      this.trackResizeObs = null;
    });

    this.onDispose(
      store.subscribe(["status", "config"], () => {
        if (!this.isViewActive) return;
        this.render();
      })
    );
    this.onDispose(
      usbPool.onChange(() => {
        if (!this.isViewActive) return;
        this.render();
      })
    );

    this.render();
    this.startActiveLoops();
  }

  public override onActivate(): void {
    this.isViewActive = true;
    const nowMs = performance.now();
    this.motionBySlot.forEach((m) => {
      m.lastTickMs = nowMs;
      m.serverPerfMs = nowMs;
    });
    this.render();
    if (this.store.simulatorRunning) {
      void this.api.pollStatusNow();
    }
    this.startActiveLoops();
  }

  public override onDeactivate(): void {
    this.isViewActive = false;
    this.stopActiveLoops();
  }

  private startActiveLoops(): void {
    if (this.pollTimer === null) {
      this.pollTimer = window.setInterval(() => {
        if (this.isViewActive && !document.hidden && this.store.simulatorRunning) {
          void this.api.pollStatusNow();
        }
      }, 300);
    }
    if (this.rafId === null) {
      const tick = (nowMs: number) => {
        if (!this.isViewActive) {
          this.rafId = null;
          return;
        }
        this.updateDronePositionsSmoothly(nowMs);
        this.rafId = window.requestAnimationFrame(tick);
      };
      this.rafId = window.requestAnimationFrame(tick);
    }
  }

  private stopActiveLoops(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private syncMotionFromSnapshot(pilots: SimPilotState[]): void {
    const nowMs = performance.now();
    const activeSlots = new Set<number>();
    const speedMult = Math.max(1, this.store.simState?.speedMultiplier || 1);

    for (const p of pilots) {
      if (!p.enabled || p.channel <= 0) continue;
      activeSlots.add(p.slotIndex);

      const baseRate =
        p.status === "FLYING" || p.status === "AVOIDING" || p.status === "LANDING"
          ? ((p.speedMph * 0.44704) / 360.0) * speedMult
          : 0;

      const existing = this.motionBySlot.get(p.slotIndex);
      if (!existing || existing.status !== p.status) {
        this.motionBySlot.set(p.slotIndex, {
          progress: p.trackProgress,
          serverProgress: p.trackProgress,
          serverPerfMs: nowMs,
          baseRate,
          status: p.status,
          lastTickMs: nowMs,
        });
        continue;
      }

      // Shortest circular difference on [0, 1)
      let err = p.trackProgress - existing.progress;
      if (err > 0.5) err -= 1.0;
      if (err < -0.5) err += 1.0;

      existing.serverProgress = p.trackProgress;
      existing.serverPerfMs = nowMs;
      if (Math.abs(err) > 0.18 || baseRate === 0) {
        existing.progress = p.trackProgress;
        existing.baseRate = baseRate;
      } else {
        existing.baseRate = existing.baseRate > 0 ? existing.baseRate * 0.6 + baseRate * 0.4 : baseRate;
      }
      existing.status = p.status;
    }

    for (const slot of this.motionBySlot.keys()) {
      if (!activeSlots.has(slot)) {
        this.motionBySlot.delete(slot);
      }
    }
  }

  private cacheCourseTrackDom(): void {
    this.droneTokensBySlot.clear();
    const layer = this.el.querySelector<HTMLElement>(".sim-drone-track-layer");
    this.trackLayerEl = layer;
    this.trackResizeObs?.disconnect();
    this.trackResizeObs = null;
    if (!layer) {
      this.trackLayerWidth = 0;
      return;
    }
    this.trackLayerWidth = layer.clientWidth || layer.getBoundingClientRect().width;
    if (typeof ResizeObserver !== "undefined") {
      this.trackResizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width;
          if (w > 0) this.trackLayerWidth = w;
        }
      });
      this.trackResizeObs.observe(layer);
    }
    layer.querySelectorAll<HTMLElement>("[data-drone-token]").forEach((tok) => {
      const slot = Number(tok.dataset.droneToken);
      if (slot > 0) {
        this.droneTokensBySlot.set(slot, tok);
      }
    });
  }

  private applyTokenSubpixelPosition(token: HTMLElement, visualFrac: number): void {
    let w = this.trackLayerWidth;
    if (w <= 0 && this.trackLayerEl) {
      w = this.trackLayerEl.clientWidth || this.trackLayerEl.getBoundingClientRect().width;
      if (w > 0) this.trackLayerWidth = w;
    }
    if (w > 0) {
      const xPx = visualFrac * w;
      token.style.transform = `translate3d(${xPx.toFixed(3)}px, 0, 0) translate(-50%, -50%)`;
    } else {
      token.style.left = `${(visualFrac * 100).toFixed(3)}%`;
    }
  }

  private updateDronePositionsSmoothly(nowMs: number): void {
    if (this.droneTokensBySlot.size === 0) return;
    const numGates = Math.max(1, this.store.nodes.length);
    const gateZeroOffset = 0.5 / numGates;

    this.motionBySlot.forEach((m, slotIndex) => {
      const dtSec = Math.min(0.08, Math.max(0, (nowMs - m.lastTickMs) / 1000));
      m.lastTickMs = nowMs;

      if (m.status === "FLYING" || m.status === "AVOIDING" || m.status === "LANDING") {
        const ageSec = Math.min(0.6, Math.max(0, (nowMs - m.serverPerfMs) / 1000));
        const targetProg = wrapUnit01(m.serverProgress + m.baseRate * ageSec);
        const predicted = wrapUnit01(m.progress + m.baseRate * dtSec);
        let err = targetProg - predicted;
        if (err > 0.5) err -= 1.0;
        if (err < -0.5) err += 1.0;
        const blend = Math.min(0.35, dtSec * 4.5);
        m.progress = wrapUnit01(predicted + err * blend);
      }

      const token = this.droneTokensBySlot.get(slotIndex);
      if (token) {
        const visualFrac = wrapUnit01(m.progress + gateZeroOffset);
        this.applyTokenSubpixelPosition(token, visualFrac);
      }
    });
  }

  private saveDraftPrefs(): void {
    try {
      window.localStorage.setItem(
        SIM_VIEW_STORAGE_KEY,
        JSON.stringify({
          addRole: this.addRole,
          addLabel: this.addLabel,
        })
      );
    } catch {
      // Ignore storage access errors
    }
  }

  private runMgpAdmin(payload: SimMultiGPAdminAction): void {
    this.mgpErrorMsg = "";
    void this.api
      .simMultiGPAdmin(payload)
      .then(() => {
        if (payload.raceId) {
          const updatedRace = this.store.simMultiGP?.races?.find((x) => x.id === payload.raceId);
          if (payload.action === "add-round") {
            const rounds = updatedRace?.schedule?.rounds ?? [];
            const newest = rounds[rounds.length - 1];
            if (newest) {
              this.mgpSelectedRoundByRace.set(payload.raceId, newest.roundNumber);
              this.mgpSelectedHeatByRace.set(
                payload.raceId,
                newest.heats?.[0]?.heatNumber ?? 1
              );
            }
          } else if (payload.action === "add-heat" && payload.roundNumber) {
            const rnd = updatedRace?.schedule?.rounds?.find(
              (x) => x.roundNumber === payload.roundNumber
            );
            const heats = rnd?.heats ?? [];
            const newestHeat = heats[heats.length - 1];
            this.mgpSelectedRoundByRace.set(payload.raceId, payload.roundNumber);
            if (newestHeat) {
              this.mgpSelectedHeatByRace.set(payload.raceId, newestHeat.heatNumber);
            }
            this.mgpPendingScrollBottomKey = `${payload.raceId}:${payload.roundNumber}`;
          }
        }
        this.lastMultiGPSig = "";
        this.renderMultiGP();
      })
      .catch((err: unknown) => {
        this.mgpErrorMsg = err instanceof Error ? err.message : String(err);
        this.lastMultiGPSig = "";
        this.renderMultiGP();
      });
  }

  private handleScrollCapture = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    if (t && t.classList.contains("sim-mgp-rail-list") && t.dataset.mgpRailKey) {
      this.mgpRailScrollByKey.set(t.dataset.mgpRailKey, t.scrollTop);
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLInputElement;
    if (e.key === "Enter" && target.dataset.field === "mgp-walkup-name") {
      e.preventDefault();
      const raceId = Number(target.dataset.raceId);
      const name = (this.mgpWalkupByRace.get(raceId) ?? target.value).trim();
      if (Number.isFinite(raceId) && name) {
        this.mgpWalkupByRace.set(raceId, "");
        target.blur();
        this.runMgpAdmin({ action: "add-pool-pilot", raceId, name });
      }
    }
  };

  private handleDragStart = (e: DragEvent): void => {
    const rawTarget = e.target as HTMLElement | null;
    if (!rawTarget) return;
    if (rawTarget.closest("select, input, button")) {
      e.preventDefault();
      return;
    }

    const pilotChip = rawTarget.closest<HTMLElement>("[data-mgp-drag-pilot]");
    if (pilotChip) {
      const raceId = Number(pilotChip.dataset.mgpRaceId);
      const pilotId = Number(pilotChip.dataset.mgpDragPilot);
      if (Number.isFinite(raceId) && Number.isFinite(pilotId) && pilotId > 0) {
        this.mgpDragPayload = { raceId, pilotId };
        pilotChip.classList.add("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData("text/plain", `pilot:${raceId}:${pilotId}`);
        }
      }
      return;
    }

    const seatRow = rawTarget.closest<HTMLElement>("[data-mgp-drag-seat]");
    if (seatRow) {
      const raceId = Number(seatRow.dataset.raceId);
      const fromRound = Number(seatRow.dataset.round);
      const fromHeat = Number(seatRow.dataset.heat);
      const fromSeatIndex = Number(seatRow.dataset.seatIndex);
      if (
        Number.isFinite(raceId) &&
        Number.isFinite(fromRound) &&
        Number.isFinite(fromHeat) &&
        Number.isFinite(fromSeatIndex)
      ) {
        this.mgpDragPayload = { raceId, fromRound, fromHeat, fromSeatIndex };
        seatRow.classList.add("is-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(
            "text/plain",
            `seat:${raceId}:${fromRound}:${fromHeat}:${fromSeatIndex}`
          );
        }
      }
    }
  };

  private handleDragOver = (e: DragEvent): void => {
    if (!this.mgpDragPayload) return;
    const dropSeat = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-mgp-drop-seat]");
    if (!dropSeat) return;
    const raceId = Number(dropSeat.dataset.raceId);
    if (raceId !== this.mgpDragPayload.raceId) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = this.mgpDragPayload.pilotId ? "copy" : "move";
    }
    this.el
      .querySelectorAll(".sim-mgp-seat-edit-row.is-drag-over")
      .forEach((el) => {
        if (el !== dropSeat) el.classList.remove("is-drag-over");
      });
    dropSeat.classList.add("is-drag-over");
  };

  private handleDragLeave = (e: DragEvent): void => {
    const dropSeat = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-mgp-drop-seat]");
    if (!dropSeat) return;
    const related = e.relatedTarget as Node | null;
    if (related && dropSeat.contains(related)) return;
    dropSeat.classList.remove("is-drag-over");
  };

  private handleDrop = (e: DragEvent): void => {
    const payload = this.mgpDragPayload;
    if (!payload) return;
    const dropSeat = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-mgp-drop-seat]");
    this.clearDragClasses();
    this.mgpDragPayload = null;
    if (!dropSeat) return;

    const raceId = Number(dropSeat.dataset.raceId);
    const roundNumber = Number(dropSeat.dataset.round);
    const heatNumber = Number(dropSeat.dataset.heat);
    const seatIndex = Number(dropSeat.dataset.seatIndex);
    if (
      raceId !== payload.raceId ||
      !Number.isFinite(roundNumber) ||
      !Number.isFinite(heatNumber) ||
      !Number.isFinite(seatIndex)
    ) {
      return;
    }
    e.preventDefault();

    if (payload.pilotId && payload.pilotId > 0) {
      this.runMgpAdmin({
        action: "assign-seat",
        raceId,
        roundNumber,
        heatNumber,
        seatIndex,
        pilotId: payload.pilotId,
      });
    } else if (
      payload.fromRound !== undefined &&
      payload.fromHeat !== undefined &&
      payload.fromSeatIndex !== undefined
    ) {
      if (
        payload.fromRound === roundNumber &&
        payload.fromHeat === heatNumber &&
        payload.fromSeatIndex === seatIndex
      ) {
        return;
      }
      this.runMgpAdmin({
        action: "move-seat",
        raceId,
        fromRound: payload.fromRound,
        fromHeat: payload.fromHeat,
        fromSeatIndex: payload.fromSeatIndex,
        roundNumber,
        heatNumber,
        seatIndex,
      });
    }
  };

  private handleDragEnd = (): void => {
    this.mgpDragPayload = null;
    this.clearDragClasses();
    this.renderMultiGP();
  };

  private clearDragClasses(): void {
    this.el
      .querySelectorAll(".is-dragging, .is-drag-over")
      .forEach((el) => el.classList.remove("is-dragging", "is-drag-over"));
  }

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field === "timer-label") {
      this.addLabel = target.value;
      this.saveDraftPrefs();
    } else if (target.dataset.field === "mgp-new-name") {
      this.mgpNewName = target.value;
    } else if (target.dataset.field === "mgp-walkup-name") {
      const raceId = Number(target.dataset.raceId);
      if (Number.isFinite(raceId)) {
        this.mgpWalkupByRace.set(raceId, target.value);
      }
    }
  };

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const field = target.dataset.field;
    if (field === "timer-role") {
      this.addRole = target.value === "hub" ? "hub" : "spoke";
      this.saveDraftPrefs();
      return;
    }
    if (field === "laprf-host") {
      const timerId = Number(target.dataset.timerId);
      const host = target.value.trim();
      if (Number.isFinite(timerId) && host) {
        void this.api.simLapRFAction({ action: "update", timerId, host });
      }
      return;
    }
    if (field === "laprf-volts") {
      const timerId = Number(target.dataset.timerId);
      const volts = Number(target.value);
      if (Number.isFinite(timerId) && Number.isFinite(volts) && volts >= 5 && volts <= 30) {
        void this.api.simLapRFAction({
          action: "update",
          timerId,
          voltageMv: Math.round(volts * 1000),
        });
      }
      return;
    }
    if (field === "rh-host") {
      const timerId = Number(target.dataset.timerId);
      const host = target.value.trim();
      if (Number.isFinite(timerId) && host) {
        void this.api.simRotorHazardAction({ action: "update", timerId, host });
      }
      return;
    }
    if (field === "rh-nodes") {
      const timerId = Number(target.dataset.timerId);
      const nodeCount = Number(target.value) === 4 ? 4 : 8;
      if (Number.isFinite(timerId)) {
        void this.api.simRotorHazardAction({ action: "update", timerId, nodeCount });
      }
      return;
    }
    if (field === "rh-user") {
      const timerId = Number(target.dataset.timerId);
      const adminUser = target.value.trim();
      if (Number.isFinite(timerId) && adminUser) {
        void this.api.simRotorHazardAction({ action: "update", timerId, adminUser });
      }
      return;
    }
    if (field === "rh-pass") {
      const timerId = Number(target.dataset.timerId);
      if (Number.isFinite(timerId)) {
        void this.api.simRotorHazardAction({
          action: "update",
          timerId,
          adminPass: target.value,
        });
      }
      return;
    }
    if (field === "mgp-chapter-name") {
      const chapterName = target.value.trim();
      if (chapterName) {
        this.runMgpAdmin({ action: "set-chapter", chapterName });
      }
      return;
    }
    if (field === "mgp-new-mode") {
      this.mgpNewMode = target.value === "zippyq" ? "zippyq" : "controlled";
      return;
    }
    if (field === "mgp-new-scoring") {
      this.mgpNewScoring = Number(target.value) || 0;
      return;
    }
    if (field === "mgp-race-scoring") {
      const raceId = Number(target.dataset.raceId);
      const scoringFormat = Number(target.value);
      if (Number.isFinite(raceId) && Number.isFinite(scoringFormat)) {
        this.runMgpAdmin({ action: "set-scoring", raceId, scoringFormat });
      }
      return;
    }
    if (field === "mgp-race-mode") {
      const raceId = Number(target.dataset.raceId);
      const isZippyQ = target.value === "zippyq";
      if (Number.isFinite(raceId)) {
        this.runMgpAdmin({ action: "set-mode", raceId, isZippyQ });
      }
      return;
    }
    if (field === "mgp-auto-zippyq" && target instanceof HTMLInputElement) {
      const raceId = Number(target.dataset.raceId);
      if (Number.isFinite(raceId)) {
        this.runMgpAdmin({ action: "set-auto-zippyq", raceId, enabled: target.checked });
      }
      return;
    }
    if (field === "mgp-seat-channel") {
      const raceId = Number(target.dataset.raceId);
      const roundNumber = Number(target.dataset.round);
      const heatNumber = Number(target.dataset.heat);
      const seatIndex = Number(target.dataset.seatIndex);
      const slot = Number(target.value);
      if (
        Number.isFinite(raceId) &&
        Number.isFinite(roundNumber) &&
        Number.isFinite(heatNumber) &&
        Number.isFinite(seatIndex) &&
        isValidEncodedSeatChannel(slot)
      ) {
        this.runMgpAdmin({
          action: "set-seat-channel",
          raceId,
          roundNumber,
          heatNumber,
          seatIndex,
          slot,
        });
      }
      return;
    }
    if (field === "mgp-seat-pilot") {
      const raceId = Number(target.dataset.raceId);
      const roundNumber = Number(target.dataset.round);
      const heatNumber = Number(target.dataset.heat);
      const seatIndex = Number(target.dataset.seatIndex);
      const pilotId = Number(target.value);
      if (
        Number.isFinite(raceId) &&
        Number.isFinite(roundNumber) &&
        Number.isFinite(heatNumber) &&
        Number.isFinite(seatIndex) &&
        Number.isFinite(pilotId)
      ) {
        this.runMgpAdmin({
          action: "assign-seat",
          raceId,
          roundNumber,
          heatNumber,
          seatIndex,
          pilotId,
        });
      }
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>("[data-action]");
    if (!btn) {
      const raceRow = target.closest<HTMLElement>(".sim-mgp-race-row:not(.timer-table-head)");
      if (
        raceRow &&
        !target.closest("select, input, button, .custom-select-wrap, .custom-select-menu")
      ) {
        const raceId = Number(raceRow.dataset.raceId);
        if (Number.isFinite(raceId) && raceId > 0) {
          if (this.expandedMgpRaceIds.has(raceId)) {
            this.expandedMgpRaceIds.delete(raceId);
          } else {
            this.expandedMgpRaceIds.add(raceId);
          }
          this.lastMultiGPSig = "";
          this.renderMultiGP();
        }
      }
      return;
    }
    if ((btn as HTMLButtonElement).disabled) return;
    const action = btn.dataset.action;

    switch (action) {
      case "toggle-walker": {
        const active = this.store.simState?.trackWalkerActive ?? false;
        void this.api.setTrackWalker(!active);
        break;
      }
      case "set-sim-speed": {
        const mult = Number(btn.dataset.speed);
        if (Number.isFinite(mult) && mult >= 1) {
          void this.api.setSimSpeed(mult);
        }
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
              await this.api.simPilotAction(p.slotIndex, "refill-launch");
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
          | "break"
          | "pause"
          | "launch"
          | "resume";
        if (Number.isFinite(slotIndex) && cmd) {
          void this.api.simPilotAction(slotIndex, cmd);
        }
        break;
      }
      case "timer-power": {
        const timerId = Number(btn.dataset.timerId);
        if (Number.isFinite(timerId)) {
          this.errorMsg = "";
          if (isLapRFMode(this.store.timingHardwareMode)) {
            void this.api.simLapRFAction({ action: "toggle-power", timerId });
          } else if (isRotorHazardMode(this.store.timingHardwareMode)) {
            void this.api.simRotorHazardAction({ action: "toggle-power", timerId });
          } else {
            void this.api.simTimerAction({ action: "toggle-power", timerId });
          }
        }
        break;
      }
      case "laprf-connect": {
        const timerId = Number(btn.dataset.timerId);
        if (Number.isFinite(timerId)) {
          this.errorMsg = "";
          void this.api.simLapRFAction({ action: "toggle-connect", timerId }).catch((err: unknown) => {
            this.errorMsg = err instanceof Error ? err.message : String(err);
            this.lastTimersSig = "";
            this.renderTimers(this.store.simState);
          });
        }
        break;
      }
      case "rh-connect": {
        const timerId = Number(btn.dataset.timerId);
        if (Number.isFinite(timerId)) {
          this.errorMsg = "";
          void this.api
            .simRotorHazardAction({ action: "toggle-connect", timerId })
            .catch((err: unknown) => {
              this.errorMsg = err instanceof Error ? err.message : String(err);
              this.lastTimersSig = "";
              this.renderTimers(this.store.simState);
            });
        }
        break;
      }
      case "timer-delete": {
        const timerId = Number(btn.dataset.timerId);
        if (Number.isFinite(timerId)) {
          this.errorMsg = "";
          const p =
            isLapRFMode(this.store.timingHardwareMode)
              ? this.api.simLapRFAction({ action: "delete", timerId })
              : isRotorHazardMode(this.store.timingHardwareMode)
                ? this.api.simRotorHazardAction({ action: "delete", timerId })
                : this.api.simTimerAction({ action: "delete", timerId });
          void p.catch((err: unknown) => {
            this.errorMsg = err instanceof Error ? err.message : String(err);
            this.lastTimersSig = "";
            this.renderTimers(this.store.simState);
          });
        }
        break;
      }
      case "timer-add": {
        this.errorMsg = "";
        const p =
          isLapRFMode(this.store.timingHardwareMode)
            ? this.api.simLapRFAction({ action: "add" })
            : isRotorHazardMode(this.store.timingHardwareMode)
              ? this.api.simRotorHazardAction({ action: "add" })
              : this.api.simTimerAction({ action: "add", role: "unflashed" });
        void p
          .then(() => {
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
      case "timer-reset-defaults": {
        this.errorMsg = "";
        const p =
          isLapRFMode(this.store.timingHardwareMode)
            ? this.api.simLapRFAction({ action: "reset" })
            : isRotorHazardMode(this.store.timingHardwareMode)
              ? this.api.simRotorHazardAction({ action: "reset" })
              : this.api.simTimerAction({ action: "reset-timers" });
        void p.then(() => {
          this.lastTimersSig = "";
          this.renderTimers(this.store.simState);
        });
        break;
      }
      case "mgp-toggle-reveal": {
        this.mgpRevealKey = !this.mgpRevealKey;
        const inp = this.el.querySelector<HTMLInputElement>('[data-testid="sim-mgp-api-key"]');
        if (inp) {
          inp.type = this.mgpRevealKey ? "text" : "password";
        }
        const label = this.mgpRevealKey ? "Hide API key" : "Reveal API key";
        btn.setAttribute("aria-label", label);
        btn.title = label;
        btn.innerHTML = this.mgpRevealKey ? icons.eyeOff(15) : icons.eye(15);
        this.lastMultiGPSig = "";
        break;
      }
      case "mgp-copy-key": {
        const key = this.store.simMultiGP?.apiKey ?? "";
        if (key && navigator.clipboard) {
          void navigator.clipboard.writeText(key).then(() => {
            this.mgpCopiedKey = true;
            this.lastMultiGPSig = "";
            this.renderMultiGP();
            window.setTimeout(() => {
              this.mgpCopiedKey = false;
              this.lastMultiGPSig = "";
              this.renderMultiGP();
            }, 1500);
          });
        }
        break;
      }
      case "mgp-regen-key": {
        this.mgpErrorMsg = "";
        void this.api.simMultiGPAdmin({ action: "regen-key" }).then(() => {
          this.lastMultiGPSig = "";
          this.renderMultiGP();
        });
        break;
      }
      case "mgp-reset": {
        this.mgpErrorMsg = "";
        void this.api.simMultiGPAdmin({ action: "reset" }).then(() => {
          sharedMultiGPService.resetDefaults(true, this.store);
          this.lastMultiGPSig = "";
          this.renderMultiGP();
        });
        break;
      }
      case "mgp-add-race": {
        this.mgpErrorMsg = "";
        const name = this.mgpNewName.trim() || "Club Night Race";
        void this.api
          .simMultiGPAdmin({
            action: "add-race",
            name,
            isZippyQ: this.mgpNewMode === "zippyq",
            scoringFormat: this.mgpNewScoring,
          })
          .then(() => {
            this.mgpNewName = "";
            this.lastMultiGPSig = "";
            this.renderMultiGP();
          })
          .catch((err: unknown) => {
            this.mgpErrorMsg = err instanceof Error ? err.message : String(err);
            this.lastMultiGPSig = "";
            this.renderMultiGP();
          });
        break;
      }
      case "mgp-queue-zippyq": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          this.runMgpAdmin({ action: "queue-zippyq", raceId });
        }
        break;
      }
      case "mgp-zippyq-checkin": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          this.runMgpAdmin({ action: "sim-zippyq-checkin", raceId });
        }
        break;
      }
      case "mgp-zippyq-lineup": {
        const raceId = Number(btn.dataset.raceId);
        const pilotId = Number(btn.dataset.pilotId || 0);
        if (Number.isFinite(raceId)) {
          this.runMgpAdmin({ action: "sim-zippyq-lineup", raceId, pilotId });
        }
        break;
      }
      case "mgp-toggle-pilot": {
        const raceId = Number(btn.dataset.raceId);
        const pilotId = Number(btn.dataset.pilotId);
        if (Number.isFinite(raceId) && Number.isFinite(pilotId)) {
          this.runMgpAdmin({ action: "toggle-pilot", raceId, pilotId });
        }
        break;
      }
      case "mgp-all-pilots": {
        const raceId = Number(btn.dataset.raceId);
        const enabled = btn.dataset.enabled === "1";
        if (Number.isFinite(raceId)) {
          this.runMgpAdmin({ action: "set-all-pilots", raceId, enabled });
        }
        break;
      }
      case "mgp-add-walkup": {
        const raceId = Number(btn.dataset.raceId);
        const inp = this.el.querySelector<HTMLInputElement>(
          `[data-field="mgp-walkup-name"][data-race-id="${raceId}"]`
        );
        const name = (this.mgpWalkupByRace.get(raceId) ?? inp?.value ?? "").trim();
        if (Number.isFinite(raceId) && name) {
          this.mgpWalkupByRace.set(raceId, "");
          inp?.blur();
          this.runMgpAdmin({ action: "add-pool-pilot", raceId, name });
        }
        break;
      }
      case "mgp-rebuild-schedule": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          this.runMgpAdmin({ action: "rebuild-schedule", raceId });
        }
        break;
      }
      case "mgp-add-round": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          const curRace = (this.store.simMultiGP?.races ?? []).find((x) => x.id === raceId);
          const nextR = (curRace?.schedule?.rounds?.length ?? 0) + 1;
          this.mgpSelectedRoundByRace.set(raceId, nextR);
          this.mgpSelectedHeatByRace.set(raceId, 1);
          this.runMgpAdmin({ action: "add-round", raceId, isZippyQ: false });
        }
        break;
      }
      case "mgp-add-zippyq-round": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          const curRace = (this.store.simMultiGP?.races ?? []).find((x) => x.id === raceId);
          const nextR = (curRace?.schedule?.rounds?.length ?? 0) + 1;
          this.mgpSelectedRoundByRace.set(raceId, nextR);
          this.mgpSelectedHeatByRace.set(raceId, 1);
          this.runMgpAdmin({ action: "add-round", raceId, isZippyQ: true });
        }
        break;
      }
      case "mgp-delete-round": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        if (Number.isFinite(raceId) && Number.isFinite(roundNumber)) {
          this.runMgpAdmin({ action: "delete-round", raceId, roundNumber });
        }
        break;
      }
      case "mgp-add-heat": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        if (Number.isFinite(raceId) && Number.isFinite(roundNumber)) {
          this.runMgpAdmin({ action: "add-heat", raceId, roundNumber });
        }
        break;
      }
      case "mgp-delete-heat": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        const heatNumber = Number(btn.dataset.heat);
        if (
          Number.isFinite(raceId) &&
          Number.isFinite(roundNumber) &&
          Number.isFinite(heatNumber)
        ) {
          this.runMgpAdmin({ action: "delete-heat", raceId, roundNumber, heatNumber });
        }
        break;
      }
      case "mgp-add-seat": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        const heatNumber = Number(btn.dataset.heat);
        if (
          Number.isFinite(raceId) &&
          Number.isFinite(roundNumber) &&
          Number.isFinite(heatNumber)
        ) {
          this.runMgpAdmin({ action: "add-seat", raceId, roundNumber, heatNumber });
        }
        break;
      }
      case "mgp-clear-seat": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        const heatNumber = Number(btn.dataset.heat);
        const seatIndex = Number(btn.dataset.seatIndex);
        if (
          Number.isFinite(raceId) &&
          Number.isFinite(roundNumber) &&
          Number.isFinite(heatNumber) &&
          Number.isFinite(seatIndex)
        ) {
          this.runMgpAdmin({
            action: "assign-seat",
            raceId,
            roundNumber,
            heatNumber,
            seatIndex,
            pilotId: 0,
          });
        }
        break;
      }
      case "mgp-delete-seat": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        const heatNumber = Number(btn.dataset.heat);
        const seatIndex = Number(btn.dataset.seatIndex);
        if (
          Number.isFinite(raceId) &&
          Number.isFinite(roundNumber) &&
          Number.isFinite(heatNumber) &&
          Number.isFinite(seatIndex)
        ) {
          this.runMgpAdmin({
            action: "delete-seat",
            raceId,
            roundNumber,
            heatNumber,
            seatIndex,
          });
        }
        break;
      }
      case "mgp-clear-uploads": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          this.runMgpAdmin({ action: "clear-uploads", raceId });
        }
        break;
      }
      case "mgp-select-round": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        if (Number.isFinite(raceId) && Number.isFinite(roundNumber)) {
          this.mgpSelectedRoundByRace.set(raceId, roundNumber);
          const race = this.store.simMultiGP?.races?.find((x) => x.id === raceId);
          const rnd = race?.schedule?.rounds?.find((x) => x.roundNumber === roundNumber);
          this.mgpSelectedHeatByRace.set(raceId, rnd?.heats?.[0]?.heatNumber ?? 1);
          this.lastMultiGPSig = "";
          this.renderMultiGP();
        }
        break;
      }
      case "mgp-select-heat": {
        const raceId = Number(btn.dataset.raceId);
        const roundNumber = Number(btn.dataset.round);
        const heatNumber = Number(btn.dataset.heat);
        if (Number.isFinite(raceId) && Number.isFinite(heatNumber)) {
          if (Number.isFinite(roundNumber)) {
            this.mgpSelectedRoundByRace.set(raceId, roundNumber);
          }
          this.mgpSelectedHeatByRace.set(raceId, heatNumber);
          this.lastMultiGPSig = "";
          this.renderMultiGP();
        }
        break;
      }
      case "mgp-mobile-mode-menu": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          const sel = this.el.querySelector<HTMLSelectElement>(
            `select[data-field="mgp-race-mode"][data-race-id="${raceId}"]`
          );
          if (sel) {
            openCustomSelect(sel, btn);
          }
        }
        break;
      }
      case "mgp-mobile-scoring-menu": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          const sel = this.el.querySelector<HTMLSelectElement>(
            `select[data-field="mgp-race-scoring"][data-race-id="${raceId}"]`
          );
          if (sel) {
            openCustomSelect(sel, btn);
          }
        }
        break;
      }
      case "mgp-toggle-results": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          if (this.expandedMgpRaceIds.has(raceId)) {
            this.expandedMgpRaceIds.delete(raceId);
          } else {
            this.expandedMgpRaceIds.add(raceId);
          }
          this.lastMultiGPSig = "";
          this.renderMultiGP();
        }
        break;
      }
      case "mgp-delete-race": {
        const raceId = Number(btn.dataset.raceId);
        if (Number.isFinite(raceId)) {
          this.mgpErrorMsg = "";
          this.expandedMgpRaceIds.delete(raceId);
          void this.api.simMultiGPAdmin({ action: "delete-race", raceId }).then(() => {
            this.lastMultiGPSig = "";
            this.renderMultiGP();
          });
        }
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
    this.renderMultiGP();
  }

  private get orderedNodes(): TrackNode[] {
    return [...this.store.nodes].sort((a, b) => a.trackOrder - b.trackOrder);
  }

  private renderCourse(simState: SimState | null): void {
    const walkerActive = simState?.trackWalkerActive ?? false;
    const walkerSec = simState?.trackWalkerSecLeft ?? 0;
    const pilots = (simState?.pilots ?? []).filter((p) => p.enabled && p.channel > 0);
    const nodes = this.orderedNodes;
    const isLapRF = isLapRFMode(this.store.timingHardwareMode);
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    const timersById = new Map<number, SimTimerState>(
      (simState?.timers ?? []).map((t) => [t.timerId, t])
    );
    const laprfById = new Map<number, SimLapRFUnit>(
      (simState?.laprfUnits ?? []).map((u) => [u.timerId, u])
    );
    const rhById = new Map<number, SimRotorHazardUnit>(
      (simState?.rotorhazardUnits ?? []).map((u) => [u.timerId, u])
    );

    const onTrackPilots = pilots.filter((p) => !isPilotInPits(p.status));
    const pitPilots = pilots.filter((p) => isPilotInPits(p.status));

    const structSig = [
      isRH ? "RH" : isLapRF ? "LPF" : "SLAP",
      walkerActive ? "W1" : "W0",
      nodes
        .map((n) => {
          if (isLapRF) {
            const u = laprfById.get(n.assignedTimerId);
            return `${n.gateId}:${n.assignedTimerId}:${n.name}:${n.role}:${u?.poweredOn && u?.connected ? 1 : 0}:${u?.color ?? ""}`;
          }
          if (isRH) {
            const u = rhById.get(n.assignedTimerId);
            return `${n.gateId}:${n.assignedTimerId}:${n.name}:${n.role}:${u?.poweredOn && u?.connected ? 1 : 0}:${u?.color ?? ""}:${u?.label ?? ""}`;
          }
          const t = timersById.get(n.assignedTimerId);
          return `${n.gateId}:${n.assignedTimerId}:${n.name}:${n.role}:${t?.poweredOn ? 1 : 0}:${t?.color ?? ""}`;
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
          const assignedId = node.assignedTimerId ?? 0;
          const hasTimer = assignedId > 0;
          const tiedTimer = timersById.get(assignedId);
          const tiedLaprf = laprfById.get(assignedId);
          const tiedRh = rhById.get(assignedId);
          const powered = isLapRF
            ? Boolean(tiedLaprf?.poweredOn && tiedLaprf?.connected)
            : isRH
              ? Boolean(tiedRh?.poweredOn && tiedRh?.connected)
              : tiedTimer
                ? tiedTimer.poweredOn
                : false;
          const givenName = isLapRF
            ? tiedLaprf?.label?.trim() || node.timerLabel?.trim()
            : isRH
              ? tiedRh?.label?.trim() || node.timerLabel?.trim()
              : tiedTimer?.timerLabel?.trim() || node.timerLabel?.trim();
          const shortCode = hasTimer
            ? isLapRF
              ? `L${Math.max(1, assignedId - 1)}`
              : isRH
                ? (givenName
                    ? /^rh(\d+)$/i.test(givenName)
                      ? `R${givenName.slice(2)}`
                      : givenName
                    : `R${Math.max(1, assignedId - 1)}`
                  ).slice(0, 2)
                : givenName
                  ? givenName.slice(0, 2)
                  : tiedTimer?.isHub
                    ? "H1"
                    : `T${Math.max(1, assignedId - 1)}`
            : "—";
          const roleSub = hasTimer
            ? isLapRF
              ? "LPF"
              : isRH
                ? "RH"
                : tiedTimer?.isHub
                  ? "HUB"
                  : "SPK"
            : "EMPTY";
          const color = hasTimer
            ? (isLapRF ? tiedLaprf?.color : isRH ? tiedRh?.color : undefined) ||
              timerColor(this.store, assignedId)
            : "#64748b";

          const lastNode = nodes[(total - 1 + total) % total];
          const lastAssignedId = lastNode?.assignedTimerId ?? 0;
          const lastColor = lastAssignedId > 0 ? timerColor(this.store, lastAssignedId) : "#64748b";

          const nextNode = nodes[(index + 1) % total];
          const nextAssignedId = nextNode?.assignedTimerId ?? 0;
          const nextColor = nextAssignedId > 0 ? timerColor(this.store, nextAssignedId) : "#64748b";

          const sectionTag = `S${index + 1}`;
          const wrapSectionTag = `S${total}`;

          return `
            <div
              class="gate-line-item sim-gate-node ${isStart ? "is-start" : ""} ${hasTimer && powered ? "has-timer" : "is-empty-gate"}"
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
              </div>

              <div class="gate-node-circle ${hasTimer ? (powered ? "is-filled" : "is-filled is-offline") : "is-unassigned"}">
                <span class="gate-node-timer-code mono">${esc(shortCode)}</span>
              </div>

              <span
                class="gate-node-start-btn ${isStart ? "is-active" : "is-placeholder-flag"}"
                ${isStart ? 'title="Start timer" aria-label="Start timer"' : 'aria-hidden="true"'}
              >${icons.checkered(13)}</span>
            </div>`;
        })
        .join("");

      const dronesHtml = onTrackPilots
        .map((p) => {
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
              style="left:0;--c:${esc(p.color)}"
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
                  ? `⚠ Person on track (${Math.ceil(walkerSec)}s left) · airborne pilots land or circle high above the track`
                  : `60 fps live course timeline · drones cross #1 → #${nodes.length} and wrap around ${nodes.length > 0 ? `S${nodes.length}` : "the loop"}`
              }
            </span>
            <div class="sim-course-actions">
              <button class="btn btn-sm ${walkerActive ? "btn-danger-active" : "btn-ghost"}" data-action="toggle-walker" ${walkerActive ? "" : "disabled"} title="End track walk recovery early and resume racing">
                ${icons.pilot(14)}
                <span>Clear track</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="pack-burst" title="Bunch airborne pilots 150 ms apart approaching the start timer">
                ${icons.zap(14)}<span>Pack burst</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="launch-all" title="Refill all 6S batteries to 100% and launch all enabled pilots">
                ${icons.play(14)}<span>Launch all</span>
              </button>
            </div>
          </div>

          <div class="gate-track-scroll sim-track-scroll">
            <div class="sim-altitude-lane-label ${walkerActive ? "is-walker-active" : ""}">
              <span data-corridor-label>${walkerActive ? `ACTIVE FLIGHT CORRIDOR · PERSON ON TRACK (${Math.ceil(walkerSec)}s)` : "ACTIVE FLIGHT CORRIDOR"}</span>
            </div>
            <div class="sim-flight-corridor ${walkerActive ? "is-walker-active" : ""}">
              <div class="sim-drone-track-layer">
                ${dronesHtml}
              </div>
            </div>

            <div class="gate-track-line sim-gate-track-line" role="list" aria-label="Simulated course timers">
              ${nodesHtml}
            </div>
          </div>

          <div class="sim-altitude-lane-label sim-pit-lane-label">
            <span data-pit-lane-label>PIT BENCH &amp; BATTERY SWAP LANE (${pitPilots.length})</span>
          </div>
          <div class="gate-unassigned-tray sim-pit-tray">
            <div class="gate-unassigned-list sim-pit-list">
              ${pitTokensHtml}
            </div>
          </div>
        </div>`;
      this.cacheCourseTrackDom();
      for (const p of onTrackPilots) {
        const tok = this.droneTokensBySlot.get(p.slotIndex);
        if (tok) {
          const m = this.motionBySlot.get(p.slotIndex);
          const prog = m ? m.progress : p.trackProgress;
          this.applyTokenSubpixelPosition(tok, wrapUnit01(prog + gateZeroOffset));
        }
      }
    } else {
      // Fast in-place update of countdowns without touching DOM structure
      if (walkerActive) {
        setTextIfChanged(
          this.el.querySelector<HTMLElement>("[data-corridor-label]"),
          `ACTIVE FLIGHT CORRIDOR · PERSON ON TRACK (${Math.ceil(walkerSec)}s)`
        );
        setTextIfChanged(
          this.el.querySelector<HTMLElement>("[data-course-caption]"),
          `⚠ Person on track (${Math.ceil(walkerSec)}s left) · airborne pilots land or circle high above the track`
        );
      }
      setTextIfChanged(
        this.el.querySelector<HTMLElement>("[data-pit-lane-label]"),
        `PIT BENCH & BATTERY SWAP LANE (${pitPilots.length})`
      );
      for (const p of onTrackPilots) {
        setTextIfChanged(
          this.el.querySelector<HTMLElement>(`[data-drone-tag="${p.slotIndex}"]`),
          formatDroneTagText(p)
        );
      }
    }
  }

  private renderPilots(simState: SimState | null): void {
    const activePilots = (simState?.pilots ?? []).filter((p) => p.enabled);

    const structSig = activePilots
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.color}:${p.band ?? 1}:${p.channel}`)
      .join("|");

    if (structSig !== this.lastPilotsStructSig) {
      this.lastPilotsStructSig = structSig;

      const cards = activePilots
        .map((p: SimPilotState) => {
          const meta = statusMeta(p);
          const chBadge =
            p.channel > 0
              ? formatBandChannelWithFreq(p.band, p.channel, p.frequencyMhz)
              : "No channel";
          const isCrashed =
            p.status === "CRASHED_VTX_ON" ||
            p.status === "TURTLE_RECOVERY" ||
            p.status === "TURTLE_FAILED" ||
            p.status === "CRASHED_WAITING_RECOVERY" ||
            p.status === "WALKING_RECOVERY";
          const isParked = isPilotInPits(p.status);
          const isFlying = p.status === "FLYING" || p.status === "AVOIDING";
          const isTurtleBusy =
            p.status === "TURTLE_RECOVERY" || p.status === "WALKING_RECOVERY";
          const isWalkingOut = p.status === "WALKING_RECOVERY";
          const canSwap =
            p.status !== "PIT_SWAP" &&
            p.status !== "CHARGING_WAIT" &&
            p.status !== "LANDING" &&
            !isCrashed;

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
                    <div class="sim-stat-k">Nearest Timer</div>
                    <div class="sim-stat-v" data-pilot-loc="${p.slotIndex}">${p.status === "LANDING" ? "Landing pad" : p.status === "LAUNCH_HOLD" ? "Launch pad" : isParked ? "Pit bench" : esc(p.nearestGateLabel)}</div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Packs / Crashes</div>
                    <div class="sim-stat-v mono" data-pilot-packs="${p.slotIndex}">#${p.packsFlown} · ${p.crashesCount} cr</div>
                  </div>
                </div>
              </div>

              <div class="sim-pilot-controls">
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="launch" data-pilot-btn="${p.slotIndex}-launch" ${isParked ? "" : "disabled"} title="Launch immediately with the battery currently attached to the quad (or best bench pack if unplugged)">
                  ${icons.play(12)}<span>Launch</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pit" data-pilot-btn="${p.slotIndex}-pit" ${canSwap ? "" : "disabled"} title="Bring pilot into the pit bench to swap to a fresh 6S battery pack (30–60s)">
                  ${icons.reset(12)}<span>Swap pack</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="break" data-pilot-btn="${p.slotIndex}-break" ${isFlying ? "" : "disabled"} title="Land in the pits and rest at the bench while batteries charge">
                  ${icons.pause(12)}<span>Land</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="crash" data-pilot-btn="${p.slotIndex}-crash" ${isFlying ? "" : "disabled"} title="Force a mid-track crash near the closest timer (VTX stays on briefly)">
                  ${icons.zapOff(12)}<span>Force crash</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="recover" data-pilot-btn="${p.slotIndex}-recover" ${isCrashed && !isTurtleBusy ? "" : "disabled"} title="Attempt Turtle Mode recovery (spins motors for 3.5s to flip upright and resume flying)">
                  ${icons.play(12)}<span>Turtle flip</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="walk-recover" data-pilot-btn="${p.slotIndex}-walk-recover" ${isCrashed && !isWalkingOut ? "" : "disabled"} title="Force immediate track walk to retrieve the crashed quad (other drones will land at the bench or fly high until clear)">
                  ${icons.pilot(12)}<span>Walk recover</span>
                </button>
              </div>
            </div>`;
        })
        .join("");

      this.slot("pilots").innerHTML = `
        <div class="sim-pilots-grid">
          ${cards || `<div class="card empty-note">No active pilots on the flight line. Start a <a href="#/live" class="link-inline">Practice</a> session and add pilots, or stage a <a href="#/races" class="link-inline">Race</a> heat with checked-in pilots to simulate their flights.</div>`}
        </div>`;
      return;
    }

    // Update live telemetry numbers & button states in-place without recreating pilot cards
    for (const p of activePilots) {
      const meta = statusMeta(p);
      const isCrashed =
        p.status === "CRASHED_VTX_ON" ||
        p.status === "TURTLE_RECOVERY" ||
        p.status === "TURTLE_FAILED" ||
        p.status === "CRASHED_WAITING_RECOVERY" ||
        p.status === "WALKING_RECOVERY";
      const isParked = isPilotInPits(p.status);
      const isFlying = p.status === "FLYING" || p.status === "AVOIDING";
      const isTurtleBusy =
        p.status === "TURTLE_RECOVERY" || p.status === "WALKING_RECOVERY";
      const isWalkingOut = p.status === "WALKING_RECOVERY";
      const canSwap =
        p.status !== "PIT_SWAP" &&
        p.status !== "CHARGING_WAIT" &&
        p.status !== "LANDING" &&
        !isCrashed;

      const cardEl = this.el.querySelector<HTMLElement>(`[data-pilot-card="${p.slotIndex}"]`);
      setClassIfChanged(cardEl, `card sim-pilot-card ${isCrashed ? "is-crashed" : ""}`);

      const badge = this.el.querySelector<HTMLElement>(`[data-pilot-badge="${p.slotIndex}"]`);
      if (badge) {
        setTextIfChanged(badge, meta.label);
        setClassIfChanged(badge, `sim-status-badge ${meta.badgeClass}`);
        if (badge.title !== meta.hint) badge.title = meta.hint;
      }
      for (const pk of p.packs ?? []) {
        const chip = formatPackStateChip(pk);
        const tone = formatPackTone(pk);
        const slotEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-slot="${p.slotIndex}-${pk.packIndex}"]`
        );
        setClassIfChanged(slotEl, `sim-pack-slot ${pk.state === "IN_QUAD" ? "is-active-pack" : ""}`);
        const chipEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-chip="${p.slotIndex}-${pk.packIndex}"]`
        );
        if (chipEl) {
          setHtmlIfChanged(chipEl, chip.html);
          setClassIfChanged(chipEl, `sim-pack-chip ${chip.cls}`);
        }
        const valEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-val="${p.slotIndex}-${pk.packIndex}"]`
        );
        setHtmlIfChanged(valEl, `<strong>${pk.pct}%</strong> · ${pk.volts.toFixed(1)}V`);
        const barEl = this.el.querySelector<HTMLElement>(
          `[data-pilot-pack-bar="${p.slotIndex}-${pk.packIndex}"]`
        );
        if (barEl) {
          setClassIfChanged(barEl, `meter-fill tone-${tone}`);
          const nextW = `${Math.max(4, pk.pct)}%`;
          if (barEl.style.width !== nextW) barEl.style.width = nextW;
        }
      }
      const speedEl = this.el.querySelector<HTMLElement>(`[data-pilot-speed="${p.slotIndex}"]`);
      setHtmlIfChanged(speedEl, `${p.speedMph.toFixed(0)} <span class="unit">mph</span>`);
      const altEl = this.el.querySelector<HTMLElement>(`[data-pilot-alt="${p.slotIndex}"]`);
      setHtmlIfChanged(altEl, `${p.altitudeMeters.toFixed(1)} <span class="unit">m</span>`);
      const vtxEl = this.el.querySelector<HTMLElement>(`[data-pilot-vtx="${p.slotIndex}"]`);
      if (vtxEl) {
        setTextIfChanged(vtxEl, formatPilotVtxText(p));
        setClassIfChanged(vtxEl, `sim-stat-v ${p.vtxActive ? "tone-good" : "muted"}`);
      }
      const locEl = this.el.querySelector<HTMLElement>(`[data-pilot-loc="${p.slotIndex}"]`);
      setTextIfChanged(
        locEl,
        p.status === "LANDING"
          ? "Landing pad"
          : p.status === "LAUNCH_HOLD"
            ? "Launch pad"
            : isParked
              ? "Pit bench"
              : p.nearestGateLabel
      );
      const packsEl = this.el.querySelector<HTMLElement>(`[data-pilot-packs="${p.slotIndex}"]`);
      setTextIfChanged(packsEl, `#${p.packsFlown} · ${p.crashesCount} cr`);

      const launchBtn = this.el.querySelector<HTMLButtonElement>(
        `[data-pilot-btn="${p.slotIndex}-launch"]`
      );
      if (launchBtn) {
        launchBtn.disabled = !isParked;
      }
      const pitBtn = this.el.querySelector<HTMLButtonElement>(
        `[data-pilot-btn="${p.slotIndex}-pit"]`
      );
      if (pitBtn) {
        pitBtn.disabled = !canSwap;
      }
      const breakBtn = this.el.querySelector<HTMLButtonElement>(
        `[data-pilot-btn="${p.slotIndex}-break"]`
      );
      if (breakBtn) {
        breakBtn.disabled = !isFlying;
      }
      const crashBtn = this.el.querySelector<HTMLButtonElement>(
        `[data-pilot-btn="${p.slotIndex}-crash"]`
      );
      if (crashBtn) {
        crashBtn.disabled = !isFlying;
      }
      const recoverBtn = this.el.querySelector<HTMLButtonElement>(
        `[data-pilot-btn="${p.slotIndex}-recover"]`
      );
      if (recoverBtn) {
        recoverBtn.disabled = !isCrashed || isTurtleBusy;
      }
      const walkBtn = this.el.querySelector<HTMLButtonElement>(
        `[data-pilot-btn="${p.slotIndex}-walk-recover"]`
      );
      if (walkBtn) {
        walkBtn.disabled = !isCrashed || isWalkingOut;
      }
    }
  }

  private renderTimers(simState: SimState | null): void {
    const isLapRF = isLapRFMode(this.store.timingHardwareMode);
    const isLapRFUSB = this.store.timingHardwareMode === "laprf_usb";
    const isRHUSB = this.store.timingHardwareMode === "rotorhazard_usb";
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);

    const titleEl = this.slot("boards-title");
    const descEl = this.slot("boards-desc");
    const footNoteEl = this.slot("boards-foot-note");
    const addBtn = this.slot("timer-add-btn") as HTMLButtonElement;
    const slotEl = this.slot("timers-table");

    if (slotEl.querySelector(".is-custom-open")) return;

    if (isRHUSB) {
      const wantTitle = "Simulated RotorHazard USB devices";
      if (titleEl && titleEl.textContent !== wantTitle) {
        titleEl.textContent = wantTitle;
      }
      if (descEl) {
        const want =
          "Virtual RotorHazard USB serial timing devices (binary serial API 36). Power devices on or off, plug in or unplug their USB cable, configure receiver node count (4 or 8), add extra USB devices, or restore defaults.";
        if (descEl.textContent !== want) descEl.textContent = want;
      }
      if (footNoteEl) {
        const want =
          "Select and connect virtual USB ports and inspect live multi-node 0-255 RSSI bars on the Network tab.";
        if (footNoteEl.textContent !== want) footNoteEl.textContent = want;
      }
      const wantAddLbl = "+ Add RotorHazard USB device";
      if (addBtn && addBtn.textContent?.trim() !== wantAddLbl) {
        addBtn.textContent = wantAddLbl;
      }

      const units = simState?.rotorhazardUnits ?? [];
      const canAdd = units.length < 6;
      if (addBtn) addBtn.disabled = !canAdd;

      const sig =
        `rhusb:${getAppTheme()}|` +
        units
          .map(
            (u) =>
              `${u.timerId}:${u.label}:${u.portName}:${u.baudRate}:${u.apiLevel}:${u.nodeCount}:${u.color}:${u.poweredOn ? 1 : 0}:${u.connected ? 1 : 0}:${u.assignedGateName}`
          )
          .join("|") +
        `|err:${this.errorMsg}`;
      if (sig === this.lastTimersSig) return;
      this.lastTimersSig = sig;

      const rows = units
        .map((u: SimRotorHazardUnit, idx: number) => {
          const rawLabel = u.label?.trim() || "";
          const displayLabel = rawLabel
            ? /^rh(\d+)$/i.test(rawLabel)
              ? `R${rawLabel.slice(2)}`
              : rawLabel
            : `R${Math.max(1, u.timerId - 1)}`;
          const nodeCount = u.nodeCount === 4 ? 4 : 8;
          const usbPort = u.portName?.trim() || `SIM-RH-USB${idx + 1}`;
          const baudRate = u.baudRate || 115200;
          const apiLevel = u.apiLevel || 36;
          const swatchColor = u.color ? adaptColorForTheme(u.color) : timerColor(this.store, u.timerId);
          return `
            <div class="timer-table-row sim-timer-table-row ${u.poweredOn ? "" : "is-offline"}" style="grid-template-columns:minmax(135px,1.1fr) minmax(108px,0.85fr) minmax(132px,1fr) minmax(96px,0.75fr) minmax(145px,1.1fr) minmax(95px,0.8fr) minmax(195px,1.4fr)">
              <div class="detected-timer-id">
                <span class="gate-color-swatch" style="--c:${esc(swatchColor)};cursor:default"></span>
                <strong class="mono">${esc(displayLabel)}</strong>
                <span class="badge mono">${u.connected && u.poweredOn ? "Plugged in" : "Unplugged"}</span>
              </div>

              <div>
                <span class="timer-status-pill ${u.poweredOn ? "is-online" : "is-offline"}">
                  <span class="status-dot ${u.poweredOn ? "is-up" : ""}"></span>
                  <span>${u.poweredOn ? "Powered on" : "Powered off"}</span>
                </span>
              </div>

              <div>
                <span class="badge mono">${esc(usbPort)}</span>
              </div>

              <div>
                <select
                  class="input mono"
                  data-field="rh-nodes"
                  data-timer-id="${u.timerId}"
                  style="width:88px;padding:4px 6px;font-size:12px"
                  aria-label="Simulated RotorHazard USB receiver node count"
                >
                  <option value="4" ${nodeCount === 4 ? "selected" : ""}>4 nodes</option>
                  <option value="8" ${nodeCount === 8 ? "selected" : ""}>8 nodes</option>
                </select>
              </div>

              <div>
                <span class="muted mono" style="font-size:12px">API ${apiLevel} · ${baudRate}</span>
              </div>

              <div>
                ${
                  u.assignedGateName
                    ? `<span>${esc(u.assignedGateName)}</span>`
                    : `<span class="muted">Off track</span>`
                }
              </div>

              <div class="sim-timer-row-actions">
                <button class="btn btn-sm btn-ghost" type="button" data-action="rh-connect" data-timer-id="${u.timerId}" ${u.poweredOn ? "" : "disabled"} title="${u.connected ? "Unplug simulated USB cable" : "Plug in simulated USB cable"}">
                  ${u.connected ? "Unplug" : "Plug in"}
                </button>
                <button class="btn btn-sm btn-ghost" type="button" data-action="timer-power" data-timer-id="${u.timerId}">
                  ${u.poweredOn ? "Turn off" : "Turn on"}
                </button>
                <button class="btn btn-sm btn-ghost sim-btn-delete" type="button" data-action="timer-delete" data-timer-id="${u.timerId}" title="Delete ${esc(displayLabel)}">
                  Delete
                </button>
              </div>
            </div>`;
        })
        .join("");

      const tableInnerHtml = `
            <div class="timer-table-row sim-timer-table-row timer-table-head" style="grid-template-columns:minmax(135px,1.1fr) minmax(108px,0.85fr) minmax(132px,1fr) minmax(96px,0.75fr) minmax(145px,1.1fr) minmax(95px,0.8fr) minmax(195px,1.4fr)">
              <span>Device</span>
              <span>Power</span>
              <span>USB Port</span>
              <span>Nodes</span>
              <span>Serial Protocol</span>
              <span>Track</span>
              <span class="num">Actions</span>
            </div>
            ${rows || `<div class="empty-note" style="padding:14px">No simulated RotorHazard USB devices. Click "+ Add RotorHazard USB device" or "Restore defaults".</div>`}`;

      slotEl.innerHTML = `
        ${this.errorMsg ? `<div class="sim-error-note">${esc(this.errorMsg)}</div>` : ""}
        <div class="table-scroll">
          <div class="slot-table timer-table">${tableInnerHtml}</div>
        </div>`;
      return;
    }

    if (isRH) {
      if (titleEl && titleEl.textContent !== "Simulated RotorHazard devices") {
        titleEl.textContent = "Simulated RotorHazard devices";
      }
      if (descEl) {
        const want =
          "Virtual RotorHazard timing devices (Raspberry Pi server on port 5000) on the simulated LAN. Power devices on or off, plug in or unplug their LAN cable, configure receiver node count (4 or 8), edit host IP or admin credentials, add extra devices, or restore defaults.";
        if (descEl.textContent !== want) descEl.textContent = want;
      }
      if (footNoteEl) {
        const want =
          "Discover and inspect live multi-node RSSI bars and clock sync for connected RotorHazard devices on the Network tab.";
        if (footNoteEl.textContent !== want) footNoteEl.textContent = want;
      }
      if (addBtn && addBtn.textContent?.trim() !== "+ Add RotorHazard device") {
        addBtn.textContent = "+ Add RotorHazard device";
      }

      const units = simState?.rotorhazardUnits ?? [];
      const canAdd = units.length < 6;
      if (addBtn) addBtn.disabled = !canAdd;

      const sig =
        `rh:${getAppTheme()}|` +
        units
          .map(
            (u) =>
              `${u.timerId}:${u.label}:${u.host}:${u.port}:${u.nodeCount}:${u.adminUser}:${u.adminPass}:${u.color}:${u.poweredOn ? 1 : 0}:${u.connected ? 1 : 0}:${u.authOk ? 1 : 0}:${u.assignedGateName}`
          )
          .join("|") +
        `|err:${this.errorMsg}`;
      if (sig === this.lastTimersSig) return;
      this.lastTimersSig = sig;

      const rows = units
        .map((u: SimRotorHazardUnit) => {
          const rawLabel = u.label?.trim() || "";
          const displayLabel = rawLabel
            ? /^rh(\d+)$/i.test(rawLabel)
              ? `R${rawLabel.slice(2)}`
              : rawLabel
            : `R${Math.max(1, u.timerId - 1)}`;
          const nodeCount = u.nodeCount === 4 ? 4 : 8;
          const swatchColor = u.color ? adaptColorForTheme(u.color) : timerColor(this.store, u.timerId);
          return `
            <div class="timer-table-row sim-timer-table-row ${u.poweredOn ? "" : "is-offline"}" style="grid-template-columns:minmax(135px,1.1fr) minmax(108px,0.85fr) minmax(145px,1.1fr) minmax(96px,0.75fr) minmax(150px,1.15fr) minmax(95px,0.8fr) minmax(195px,1.4fr)">
              <div class="detected-timer-id">
                <span class="gate-color-swatch" style="--c:${esc(swatchColor)};cursor:default"></span>
                <strong class="mono">${esc(displayLabel)}</strong>
                <span class="badge mono">${u.connected && u.poweredOn ? "Plugged in" : "Unplugged"}</span>
              </div>

              <div>
                <span class="timer-status-pill ${u.poweredOn ? "is-online" : "is-offline"}">
                  <span class="status-dot ${u.poweredOn ? "is-up" : ""}"></span>
                  <span>${u.poweredOn ? "Powered on" : "Powered off"}</span>
                </span>
              </div>

              <div style="display:flex;align-items:center;gap:6px">
                <input
                  class="input mono"
                  type="text"
                  value="${esc(u.host)}"
                  data-field="rh-host"
                  data-timer-id="${u.timerId}"
                  style="width:116px;padding:4px 8px;font-size:12px"
                  aria-label="Simulated RotorHazard IP address"
                />
                <span class="muted mono" style="font-size:11px">:${u.port || 5000}</span>
              </div>

              <div>
                <select
                  class="input mono"
                  data-field="rh-nodes"
                  data-timer-id="${u.timerId}"
                  style="width:88px;padding:4px 6px;font-size:12px"
                  aria-label="Simulated RotorHazard receiver node count"
                >
                  <option value="4" ${nodeCount === 4 ? "selected" : ""}>4 nodes</option>
                  <option value="8" ${nodeCount === 8 ? "selected" : ""}>8 nodes</option>
                </select>
              </div>

              <div style="display:flex;align-items:center;gap:5px" title="Simulated RotorHazard HTTP Basic Auth admin credentials">
                <input
                  class="input mono"
                  type="text"
                  value="${esc(u.adminUser || "admin")}"
                  data-field="rh-user"
                  data-timer-id="${u.timerId}"
                  style="width:66px;padding:4px 6px;font-size:12px"
                  aria-label="Simulated RotorHazard admin username"
                />
                <span class="muted mono" style="font-size:11px">/</span>
                <input
                  class="input mono"
                  type="text"
                  value="${esc(u.adminPass || "rotorhazard")}"
                  data-field="rh-pass"
                  data-timer-id="${u.timerId}"
                  style="width:86px;padding:4px 6px;font-size:12px"
                  aria-label="Simulated RotorHazard admin password"
                />
              </div>

              <div>
                ${
                  u.assignedGateName
                    ? `<span>${esc(u.assignedGateName)}</span>`
                    : `<span class="muted">Off track</span>`
                }
              </div>

              <div class="sim-timer-row-actions">
                <button class="btn btn-sm btn-ghost" type="button" data-action="rh-connect" data-timer-id="${u.timerId}" ${u.poweredOn ? "" : "disabled"} title="${u.connected ? "Unplug simulated Ethernet cable" : "Plug in simulated Ethernet cable"}">
                  ${u.connected ? "Unplug" : "Plug in"}
                </button>
                <button class="btn btn-sm btn-ghost" type="button" data-action="timer-power" data-timer-id="${u.timerId}">
                  ${u.poweredOn ? "Turn off" : "Turn on"}
                </button>
                <button class="btn btn-sm btn-ghost sim-btn-delete" type="button" data-action="timer-delete" data-timer-id="${u.timerId}" title="Delete ${esc(displayLabel)}">
                  Delete
                </button>
              </div>
            </div>`;
        })
        .join("");

      const tableInnerHtml = `
            <div class="timer-table-row sim-timer-table-row timer-table-head" style="grid-template-columns:minmax(135px,1.1fr) minmax(108px,0.85fr) minmax(145px,1.1fr) minmax(96px,0.75fr) minmax(150px,1.15fr) minmax(95px,0.8fr) minmax(195px,1.4fr)">
              <span>Device</span>
              <span>Power</span>
              <span>Host : Port</span>
              <span>Nodes</span>
              <span>Admin Auth</span>
              <span>Track</span>
              <span class="num">Actions</span>
            </div>
            ${rows || `<div class="empty-note" style="padding:14px">No simulated RotorHazard devices. Click "+ Add RotorHazard device" or "Restore defaults".</div>`}`;

      slotEl.innerHTML = `
        ${this.errorMsg ? `<div class="sim-error-note">${esc(this.errorMsg)}</div>` : ""}
        <div class="table-scroll">
          <div class="slot-table timer-table">${tableInnerHtml}</div>
        </div>`;
      return;
    }

    if (isLapRF) {
      const wantTitle = isLapRFUSB ? "Simulated LapRF USB timers" : "Simulated LapRF timers";
      if (titleEl && titleEl.textContent !== wantTitle) {
        titleEl.textContent = wantTitle;
      }
      if (descEl) {
        const want = isLapRFUSB
          ? "Virtual LapRF 8-Way USB timers (115200 baud CDC serial). Power units on or off, plug in or unplug their USB cable, edit supply voltage, add extra timers, or restore defaults."
          : "Virtual LapRF 8-Way timers on the simulated LAN. Power units on or off, plug in or unplug their LAN cable, edit host IP or supply voltage, add extra timers, or restore defaults.";
        if (descEl.textContent !== want) descEl.textContent = want;
      }
      if (footNoteEl) {
        const want = isLapRFUSB
          ? "Connect virtual LapRF USB ports and inspect live 8-slot RSSI bars on the Network tab."
          : "Discover and inspect live 8-slot RSSI bars for connected LapRF timers on the Network tab.";
        if (footNoteEl.textContent !== want) footNoteEl.textContent = want;
      }
      const wantAddLbl = isLapRFUSB ? "+ Add LapRF USB timer" : "+ Add LapRF timer";
      if (addBtn && addBtn.textContent?.trim() !== wantAddLbl) {
        addBtn.textContent = wantAddLbl;
      }

      const units = simState?.laprfUnits ?? [];
      const canAdd = units.length < 6;
      if (addBtn) addBtn.disabled = !canAdd;

      const sig =
        `laprf:${isLapRFUSB ? "usb" : "net"}:${getAppTheme()}|` +
        units
          .map(
            (u) =>
              `${u.timerId}:${u.label}:${u.host}:${u.port}:${u.portName ?? ""}:${u.color}:${u.poweredOn ? 1 : 0}:${u.connected ? 1 : 0}:${u.voltageMv}:${u.assignedGateName}`
          )
          .join("|") +
        `|err:${this.errorMsg}`;
      if (sig === this.lastTimersSig) return;
      this.lastTimersSig = sig;

      const rows = units
        .map((u: SimLapRFUnit, idx: number) => {
          const displayLabel =
            !u.label || /^laprf\s*#/i.test(u.label.trim())
              ? `L${Math.max(1, u.timerId - 1)}`
              : u.label;
          const volts = u.voltageMv > 0 ? (u.voltageMv / 1000).toFixed(1) : "12.2";
          const linkText = !u.poweredOn
            ? "Offline"
            : u.connected
              ? "Plugged in"
              : isLapRFUSB
                ? "USB unplugged"
                : "Unplugged on LAN";
          const swatchColor = u.color ? adaptColorForTheme(u.color) : timerColor(this.store, u.timerId);
          const usbPortName = u.portName?.trim() || `SIM-LAPRF-USB${idx + 1}`;
          const endpointColHtml = isLapRFUSB
            ? `<div style="display:flex;align-items:center;gap:6px">
                <span class="mono" style="font-size:12px">${esc(usbPortName)}</span>
                <span class="muted mono" style="font-size:11px">115200</span>
              </div>`
            : `<div style="display:flex;align-items:center;gap:6px">
                <input
                  class="input mono"
                  type="text"
                  value="${esc(u.host)}"
                  data-field="laprf-host"
                  data-timer-id="${u.timerId}"
                  style="width:118px;padding:4px 8px;font-size:12px"
                  aria-label="Simulated LapRF IP address"
                />
                <span class="muted mono" style="font-size:11px">:${u.port || 5403}</span>
              </div>`;
          const cableTitle = isLapRFUSB
            ? u.connected
              ? "Unplug simulated USB cable"
              : "Plug in simulated USB cable"
            : u.connected
              ? "Unplug simulated Ethernet cable"
              : "Plug in simulated Ethernet cable";
          return `
            <div class="timer-table-row sim-timer-table-row ${u.poweredOn ? "" : "is-offline"}" style="grid-template-columns:minmax(140px,1.2fr) minmax(110px,0.9fr) minmax(145px,1.1fr) minmax(105px,0.8fr) minmax(95px,0.8fr) minmax(195px,1.4fr)">
              <div class="detected-timer-id">
                <span class="gate-color-swatch" style="--c:${esc(swatchColor)};cursor:default"></span>
                <strong class="mono">${esc(displayLabel)}</strong>
                <span class="badge mono">${u.connected && u.poweredOn ? "Plugged in" : "Unplugged"}</span>
              </div>

              <div>
                <span class="timer-status-pill ${u.poweredOn ? "is-online" : "is-offline"}">
                  <span class="status-dot ${u.poweredOn ? "is-up" : ""}"></span>
                  <span>${u.poweredOn ? "Powered on" : "Powered off"}</span>
                </span>
              </div>

              ${endpointColHtml}

              <div style="display:flex;align-items:center;gap:5px" title="Measured LapRF supply voltage (${esc(linkText)})">
                <input
                  class="input mono"
                  type="number"
                  step="0.1"
                  min="5"
                  max="28"
                  value="${volts}"
                  data-field="laprf-volts"
                  data-timer-id="${u.timerId}"
                  style="width:68px;padding:4px 6px;font-size:12px;text-align:right"
                  aria-label="Simulated LapRF supply voltage in volts"
                />
                <span class="muted mono" style="font-size:12px">V</span>
              </div>

              <div>
                ${
                  u.assignedGateName
                    ? `<span>${esc(u.assignedGateName)}</span>`
                    : `<span class="muted">Off track</span>`
                }
              </div>

              <div class="sim-timer-row-actions">
                <button class="btn btn-sm btn-ghost" type="button" data-action="laprf-connect" data-timer-id="${u.timerId}" ${u.poweredOn ? "" : "disabled"} title="${cableTitle}">
                  ${u.connected ? "Unplug" : "Plug in"}
                </button>
                <button class="btn btn-sm btn-ghost" type="button" data-action="timer-power" data-timer-id="${u.timerId}">
                  ${u.poweredOn ? "Turn off" : "Turn on"}
                </button>
                <button class="btn btn-sm btn-ghost sim-btn-delete" type="button" data-action="timer-delete" data-timer-id="${u.timerId}" title="Delete ${esc(displayLabel)}">
                  Delete
                </button>
              </div>
            </div>`;
        })
        .join("");

      const tableInnerHtml = `
            <div class="timer-table-row sim-timer-table-row timer-table-head" style="grid-template-columns:minmax(140px,1.2fr) minmax(110px,0.9fr) minmax(145px,1.1fr) minmax(105px,0.8fr) minmax(95px,0.8fr) minmax(195px,1.4fr)">
              <span>Timer</span>
              <span>Power</span>
              <span>${isLapRFUSB ? "USB Port" : "Host : Port"}</span>
              <span>Voltage</span>
              <span>Track</span>
              <span class="num">Actions</span>
            </div>
            ${rows || `<div class="empty-note" style="padding:14px">No simulated LapRF timers. Click "${esc(wantAddLbl)}" or "Restore defaults".</div>`}`;

      const slotEl = this.slot("timers-table");
      slotEl.innerHTML = `
        ${this.errorMsg ? `<div class="sim-error-note">${esc(this.errorMsg)}</div>` : ""}
        <div class="table-scroll">
          <div class="slot-table timer-table">${tableInnerHtml}</div>
        </div>`;
      return;
    }

    if (titleEl && titleEl.textContent !== "Simulated boards") {
      titleEl.textContent = "Simulated boards";
    }
    if (descEl) {
      const want =
        "Virtual Seeed XIAO ESP32-C5 boards (Board #1..#7). Each board's role (Hub, Spoke, or Unflashed), ID, and firmware depend on what it has been flashed with in the Flasher. Power boards on or off, add blank boards, or restore defaults.";
      if (descEl.textContent !== want) descEl.textContent = want;
    }
    if (footNoteEl) {
      const want = "Connect any powered-on board over USB in the Flasher to flash or erase its firmware.";
      if (footNoteEl.textContent !== want) footNoteEl.textContent = want;
    }
    if (addBtn && addBtn.textContent?.trim() !== "+ Add blank board") {
      addBtn.textContent = "+ Add blank board";
    }

    const timers = simState?.timers ?? [];
    const canAdd = timers.length < 7; // Up to 7 simulated XIAO ESP32-C5 boards
    const usbConnectedIds = new Set<number>();
    for (const c of usbPool.slots) {
      if (c.connected && isSimulatedSerialPort(c.rawPort)) {
        usbConnectedIds.add(c.rawPort.simulatedTimerId);
      }
    }
    const sig =
      `slaprf:${getAppTheme()}|` +
      timers
        .map(
          (t) =>
            `${t.timerId}:${t.timerLabel}:${t.color}:${t.isHub ? 1 : 0}:${t.unflashed ? 1 : 0}:${t.firmwareVersion}:${t.poweredOn ? 1 : 0}:${t.assignedGateName}:${usbConnectedIds.has(t.timerId) ? 1 : 0}`
        )
        .join("|") +
      `|err:${this.errorMsg}`;
    if (sig === this.lastTimersSig) return;
    this.lastTimersSig = sig;

    if (addBtn) addBtn.disabled = !canAdd;

    // Matches `.slot-table.timer-table` / `.timer-table-row` from `TimersList.ts` in System
    const rows = timers
      .map((t: SimTimerState) => {
        const unflashed = Boolean(t.unflashed);
        const title = unflashed
          ? `Board #${t.timerId}`
          : t.timerLabel?.trim()
            ? t.timerLabel.trim().slice(0, 2)
            : t.isHub
              ? "H1"
              : `T${Math.max(1, t.timerId - 1)}`;
        const color = unflashed ? "#64748b" : timerColor(this.store, t.timerId);
        const isUsbConnected = usbConnectedIds.has(t.timerId);

        return `
          <div class="timer-table-row sim-timer-table-row ${t.poweredOn ? "" : "is-offline"}">
            <div class="detected-timer-id">
              <span class="gate-color-swatch" style="--c:${esc(color)};cursor:default"></span>
              <strong class="mono">${esc(title)}</strong>
              ${unflashed ? "" : `<span class="muted mono sim-board-sub-id" style="font-size:11px">#${t.timerId}</span>`}
              ${isUsbConnected ? `<span class="badge tone-good sim-board-usb-badge" title="Connected over simulated USB">USB</span>` : ""}
            </div>

            <div>
              <span class="timer-status-pill ${t.poweredOn ? "is-online" : "is-offline"}" title="${t.poweredOn ? "Powered on" : "Powered off"}">
                <span class="status-dot ${t.poweredOn ? "is-up" : ""}"></span>
                <span class="sim-power-text">${t.poweredOn ? "Powered on" : "Powered off"}</span>
              </span>
            </div>

            <div>
              <span class="detected-role-pill ${unflashed ? "is-unflashed" : ""}">${unflashed ? "Unflashed" : t.isHub ? "Hub" : "Spoke"}</span>
            </div>

            <div class="timer-fw-cell" title="${unflashed ? "No SlapRF firmware flashed" : `SlapRF firmware ${esc(t.firmwareVersion)}`}">
              ${
                unflashed
                  ? `<span class="muted">Factory blank</span>`
                  : `<span class="mono">${esc(t.firmwareVersion)}</span>`
              }
            </div>

            <div class="sim-col-track">
              ${
                unflashed
                  ? `<span class="muted">—</span>`
                  : t.assignedGateName
                    ? `<span>${esc(t.assignedGateName)}</span>`
                    : `<span class="muted">Off track</span>`
              }
            </div>

            <div class="sim-timer-row-actions">
              <button class="btn btn-sm btn-ghost sim-btn-power ${t.poweredOn ? "is-powered" : "is-unpowered"}" data-action="timer-power" data-timer-id="${t.timerId}" title="${t.poweredOn ? "Turn off" : "Turn on"}" aria-label="${t.poweredOn ? "Turn off" : "Turn on"}">
                ${icons.power(14)}<span class="sim-action-label">${t.poweredOn ? "Turn off" : "Turn on"}</span>
              </button>
              <button class="btn btn-sm btn-ghost sim-btn-delete" data-action="timer-delete" data-timer-id="${t.timerId}" title="Delete simulated board #${t.timerId}" aria-label="Delete simulated board #${t.timerId}">
                ${icons.trash(14)}<span class="sim-action-label">Delete</span>
              </button>
            </div>
          </div>`;
      })
      .join("");

    const tableInnerHtml = `
          <div class="timer-table-row sim-timer-table-row timer-table-head">
            <span>Board</span>
            <span>Power</span>
            <span>Role</span>
            <span>Firmware</span>
            <span class="sim-col-track">Track</span>
            <span class="num">Actions</span>
          </div>
          ${rows}`;

    slotEl.innerHTML = `
      ${this.errorMsg ? `<div class="sim-error-note">${esc(this.errorMsg)}</div>` : ""}
      <div class="table-scroll">
        <div class="slot-table timer-table sim-boards-table">${tableInnerHtml}
        </div>
      </div>`;
  }

  private renderMultiGP(): void {
    const mgp: SimMultiGPState | null = this.store.simMultiGP;
    const host = this.slot("multigp");
    if (!host) return;

    if (!mgp) {
      if (this.lastMultiGPSig !== "empty") {
        this.lastMultiGPSig = "empty";
        host.innerHTML = `<div class="card empty-note">Turn on Simulation active in Settings to inspect and manage the Simulated MultiGP chapter and races.</div>`;
      }
      return;
    }

    if (this.mgpDragPayload || host.querySelector(".is-custom-open")) {
      return;
    }
    const activeEl = document.activeElement as HTMLElement | null;
    if (
      activeEl &&
      host.contains(activeEl) &&
      (activeEl.tagName === "INPUT" || activeEl.tagName === "SELECT") &&
      activeEl.getAttribute("data-testid") !== "sim-mgp-api-key"
    ) {
      return;
    }

    const pool = mgp.pilotPool ?? [];
    const sig = JSON.stringify({
      chapterId: mgp.chapterId,
      chapterName: mgp.chapterName,
      apiKey: mgp.apiKey,
      reveal: this.mgpRevealKey,
      copied: this.mgpCopiedKey,
      err: this.mgpErrorMsg,
      expanded: [...this.expandedMgpRaceIds].sort((a, b) => a - b),
      selRound: [...this.mgpSelectedRoundByRace.entries()].sort((a, b) => a[0] - b[0]),
      selHeat: [...this.mgpSelectedHeatByRace.entries()].sort((a, b) => a[0] - b[0]),
      pool: pool.map((p) => `${p.pilotId}:${p.userName}`),
      races: (mgp.races ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        scoring: r.scoringFormat,
        zippy: r.disableSlotAutoPopulation,
        autoZippy: Boolean(r.autoQueueZippyQ),
        entries: (r.entries ?? []).map((e) => e.pilotId),
        overallSyncedAt: r.overallSyncedAt ?? "",
        overallLen: r.overallResults?.length ?? 0,
        rounds: (r.schedule?.rounds ?? []).map((rnd) => ({
          r: rnd.roundNumber,
          heats: (rnd.heats ?? []).map((h) => ({
            h: h.heatNumber,
            seats: (h.entries ?? []).map(
              (e) =>
                `${e.slot}:${e.pilotId}:${e.syncedAt ? 1 : 0}:${e.totalLaps ?? 0}:${e.fastestLapTime ?? 0}`
            ),
          })),
        })),
      })),
    });
    if (sig === this.lastMultiGPSig) return;
    this.lastMultiGPSig = sig;

    const scoringOptions = (selected: number) =>
      [0, 1, 2, 6]
        .map(
          (code) =>
            `<option value="${code}" ${code === selected ? "selected" : ""}>${esc(formatMultiGPScoring(code))}</option>`
        )
        .join("");

    const channelOptions = (selectedSlot: number) =>
      renderMultiBandSelectOptionsHtml({
        selectedEncoded: selectedSlot,
        compact: true,
      });

    const racesList = mgp.races ?? [];
    const racesRowsHtml = racesList
      .map((r: MultiGPRaceViewData) => {
        const isZippyQ = r.disableSlotAutoPopulation === 1;
        const rounds = r.schedule?.rounds ?? [];
        const heatCount = rounds.reduce((sum, rnd) => sum + (rnd.heats?.length ?? 0), 0);
        const syncedSlots = rounds.reduce(
          (acc, rnd) =>
            acc +
            (rnd.heats ?? []).reduce(
              (hAcc, h) => hAcc + (h.entries ?? []).filter((e) => Boolean(e.syncedAt)).length,
              0
            ),
          0
        );
        const hasOverall = (r.overallResults?.length ?? 0) > 0;
        const isSyncedAny = syncedSlots > 0 || hasOverall;
        const syncTooltip = isSyncedAny
          ? `Uploaded: ${syncedSlots} slot result${syncedSlots === 1 ? "" : "s"}${hasOverall ? " + overall podium" : ""}`
          : "No results uploaded yet";
        const expanded = this.expandedMgpRaceIds.has(r.id);

        let expandedHtml = "";
        if (expanded) {
          const checkedInEntries = r.entries ?? [];
          const checkedInIds = new Set<number>(checkedInEntries.map((e) => e.pilotId));
          const uncheckedPool = pool.filter((p) => !checkedInIds.has(p.pilotId));
          const walkupVal = this.mgpWalkupByRace.get(r.id) ?? "";

          const seatPilotOptions = (selectedPilotId: number) => {
            const opts = [
              `<option value="0" ${selectedPilotId <= 0 ? "selected" : ""}>— Empty seat —</option>`,
            ];
            for (const p of checkedInEntries) {
              opts.push(
                `<option value="${p.pilotId}" ${p.pilotId === selectedPilotId ? "selected" : ""}>${esc(p.userName)}</option>`
              );
            }
            for (const p of uncheckedPool) {
              opts.push(
                `<option value="${p.pilotId}" ${p.pilotId === selectedPilotId ? "selected" : ""}>${esc(p.userName)} (check in)</option>`
              );
            }
            return opts.join("");
          };

          const checkedInChipsHtml =
            checkedInEntries.length > 0
              ? checkedInEntries
                  .map(
                    (p) => `
                    <div
                      class="sim-mgp-pilot-chip is-checked"
                      draggable="true"
                      data-mgp-drag-pilot="${p.pilotId}"
                      data-mgp-race-id="${r.id}"
                      title="Drag ${esc(p.userName)} onto any heat seat below"
                    >
                      <span class="sim-mgp-grip">${icons.grip(12)}</span>
                      <strong>${esc(p.userName)}</strong>
                      <button
                        type="button"
                        class="sim-mgp-chip-remove"
                        data-action="mgp-toggle-pilot"
                        data-race-id="${r.id}"
                        data-pilot-id="${p.pilotId}"
                        title="Remove ${esc(p.userName)} from race roster"
                        aria-label="Remove ${esc(p.userName)}"
                      >
                        ${icons.close(11)}
                      </button>
                    </div>`
                  )
                  .join("")
              : `<span class="note">No pilots checked into this race yet — click pilots from the chapter pool below or add a walk-up.</span>`;

          const poolBarHtml =
            uncheckedPool.length > 0
              ? `<div class="sim-mgp-pool-bar">
                  <span class="sim-mgp-pool-label">Chapter pool (click to check in):</span>
                  <div class="sim-mgp-pilot-chips">
                    ${uncheckedPool
                      .map(
                        (p) => `
                        <button
                          type="button"
                          class="sim-mgp-pilot-chip is-pool"
                          data-action="mgp-toggle-pilot"
                          data-race-id="${r.id}"
                          data-pilot-id="${p.pilotId}"
                          title="Check ${esc(p.userName)} into ${esc(r.name)}"
                        >
                          <span>+ ${esc(p.userName)}</span>
                        </button>`
                      )
                      .join("")}
                  </div>
                </div>`
              : "";

          const zippySimBarHtml = isZippyQ
            ? `<div class="sim-mgp-zippy-bar">
                <div class="sim-mgp-zippy-info">
                  <strong>ZippyQ flight-line simulation</strong>
                  <span class="muted">Simulates walk-up pilots checking in and lining up into open VTX seats as heats progress.</span>
                </div>
                <div class="sim-mgp-zippy-controls">
                  <label class="sim-mgp-auto-toggle">
                    <span>Auto check-in &amp; line-up</span>
                    <span class="switch">
                      <input
                        type="checkbox"
                        data-field="mgp-auto-zippyq"
                        data-race-id="${r.id}"
                        ${r.autoQueueZippyQ ? "checked" : ""}
                      />
                      <span></span>
                    </span>
                  </label>
                  <button
                    class="btn btn-xs btn-ghost"
                    type="button"
                    data-action="mgp-zippyq-checkin"
                    data-race-id="${r.id}"
                    ${uncheckedPool.length === 0 ? "disabled" : ""}
                    title="Check in one walk-up pilot from the chapter pool"
                  >
                    + Check in pilot
                  </button>
                  <button
                    class="btn btn-xs btn-ghost"
                    type="button"
                    data-action="mgp-zippyq-lineup"
                    data-race-id="${r.id}"
                    title="Line up the next eligible pilot into an open ZippyQ seat (or open a new ZippyQ round)"
                  >
                    + Line up pilot
                  </button>
                </div>
              </div>`
            : "";

          const storedRoundNum = this.mgpSelectedRoundByRace.get(r.id);
          const activeRound =
            rounds.find((x) => x.roundNumber === storedRoundNum) ?? rounds[0] ?? null;
          if (activeRound && activeRound.roundNumber !== storedRoundNum) {
            this.mgpSelectedRoundByRace.set(r.id, activeRound.roundNumber);
          }

          const activeHeats = activeRound?.heats ?? [];
          const storedHeatNum = this.mgpSelectedHeatByRace.get(r.id);
          const activeHeat =
            activeHeats.find((x) => x.heatNumber === storedHeatNum) ??
            (storedHeatNum !== undefined && activeHeats.length > 0
              ? activeHeats.reduce((best, cur) =>
                  Math.abs(cur.heatNumber - storedHeatNum) <
                  Math.abs(best.heatNumber - storedHeatNum)
                    ? cur
                    : best
                )
              : activeHeats[0]) ??
            null;
          if (activeHeat && activeHeat.heatNumber !== storedHeatNum) {
            this.mgpSelectedHeatByRace.set(r.id, activeHeat.heatNumber);
          }

          const roundPillsHtml = `
            <div class="sim-mgp-round-pills-bar" role="tablist" aria-label="Rounds for ${esc(r.name)}">
              <button
                type="button"
                class="sim-mgp-round-pill is-add"
                data-action="mgp-add-round"
                data-race-id="${r.id}"
                title="Add a regular scheduled round to ${esc(r.name)}"
              >
                ${icons.plus(12)}<span>Round</span>
              </button>
              <button
                type="button"
                class="sim-mgp-round-pill is-add"
                data-action="mgp-add-zippyq-round"
                data-race-id="${r.id}"
                title="Add a ZippyQ round to ${esc(r.name)}"
              >
                ${icons.plus(12)}<span>ZippyQ Round</span>
              </button>
              ${rounds
                .map((rnd) => {
                  const rndHeats = rnd.heats ?? [];
                  const isRoundActive = activeRound?.roundNumber === rnd.roundNumber;
                  return `
                    <button
                      type="button"
                      role="tab"
                      aria-selected="${isRoundActive ? "true" : "false"}"
                      class="sim-mgp-round-pill ${isRoundActive ? "is-active" : ""}"
                      data-action="mgp-select-round"
                      data-race-id="${r.id}"
                      data-round="${rnd.roundNumber}"
                    >
                      <span>${esc(rnd.name || `Round ${rnd.roundNumber}`)}</span>
                      <span class="sim-mgp-round-pill-count mono">${rndHeats.length}</span>
                    </button>`;
                })
                .join("")}
            </div>`;

          let splitBodyHtml = `<p class="note">No rounds scheduled yet — click <strong>+ Round</strong> above or <strong>Auto-seed heats</strong> to generate heats.</p>`;

          if (activeRound) {
            const roundLabel = activeRound.name || `Round ${activeRound.roundNumber}`;
            const railItemsHtml =
              activeHeats.length > 0
                ? activeHeats
                    .map((h) => {
                      const hEntries = h.entries ?? [];
                      const occCount = hEntries.filter((e) => e.pilotId > 0).length;
                      const heatSynced = hEntries.some((e) => Boolean(e.syncedAt));
                      const isHeatActive = activeHeat?.heatNumber === h.heatNumber;
                      const hTitle = h.name || `Heat ${h.heatNumber}`;
                      return `
                        <div
                          class="sim-mgp-heat-nav-item ${isHeatActive ? "is-active" : ""}"
                        >
                          <button
                            type="button"
                            class="sim-mgp-heat-nav-select"
                            data-action="mgp-select-heat"
                            data-race-id="${r.id}"
                            data-round="${activeRound.roundNumber}"
                            data-heat="${h.heatNumber}"
                          >
                            <span class="sim-mgp-heat-nav-label">
                              <strong>${esc(hTitle)}</strong>
                              ${heatSynced ? `<span class="status-dot is-up" title="Uploaded to MultiGP"></span>` : ""}
                            </span>
                            <span class="sim-mgp-heat-nav-meta mono">${occCount}/${hEntries.length} seated</span>
                          </button>
                          <button
                            type="button"
                            class="btn btn-xs btn-ghost sim-mgp-seat-icon-btn sim-mgp-heat-nav-del sim-btn-delete"
                            data-action="mgp-delete-heat"
                            data-race-id="${r.id}"
                            data-round="${activeRound.roundNumber}"
                            data-heat="${h.heatNumber}"
                            title="Delete ${esc(hTitle)}"
                            aria-label="Delete ${esc(hTitle)}"
                          >
                            ${icons.trash(12)}
                          </button>
                        </div>`;
                    })
                    .join("")
                : `<div class="sim-mgp-rail-empty note">No heats in ${esc(roundLabel)} yet — click <strong>+ Heat</strong> above.</div>`;

            let rightDetailHtml = `
              <div class="sim-mgp-heat-detail is-empty">
                <p class="note">No heat selected in ${esc(roundLabel)} — click <strong>+ Heat</strong> on the left to add one.</p>
              </div>`;

            if (activeHeat) {
              const entries = activeHeat.entries ?? [];
              const occInActive = entries.filter((e) => e.pilotId > 0).length;
              const heatLabel = activeHeat.name || `Heat ${activeHeat.heatNumber}`;
              const seatRowsHtml = entries
                .map((e, seatIdx) => {
                  const slotCh = isValidEncodedSeatChannel(e.slot) ? e.slot : 1;
                  const occupied = e.pilotId > 0;
                  const hasResult = Boolean(e.syncedAt);
                  const resultSummary = hasResult
                    ? `${e.totalLaps ?? 0}L${e.fastestLapTime ? ` · ${e.fastestLapTime.toFixed(2)}s` : ""}`
                    : "";
                  return `
                    <div
                      class="sim-mgp-seat-edit-row ${occupied ? "is-occupied" : "is-empty"}"
                      data-mgp-drop-seat="1"
                      data-race-id="${r.id}"
                      data-round="${activeRound.roundNumber}"
                      data-heat="${activeHeat.heatNumber}"
                      data-seat-index="${seatIdx}"
                    >
                      <span
                        class="sim-mgp-seat-drag ${occupied ? "is-draggable" : ""}"
                        ${
                          occupied
                            ? `draggable="true" data-mgp-drag-seat="1" data-race-id="${r.id}" data-round="${activeRound.roundNumber}" data-heat="${activeHeat.heatNumber}" data-seat-index="${seatIdx}" title="Drag ${esc(e.userName || "pilot")} to move or swap seats"`
                            : `title="Drop a pilot here"`
                        }
                      >
                        ${icons.grip(12)}
                      </span>

                      <select
                        class="input sim-mgp-ch-select"
                        data-field="mgp-seat-channel"
                        data-race-id="${r.id}"
                        data-round="${activeRound.roundNumber}"
                        data-heat="${activeHeat.heatNumber}"
                        data-seat-index="${seatIdx}"
                        aria-label="Channel for ${esc(roundLabel)} ${esc(heatLabel)} seat ${seatIdx + 1}"
                      >
                        ${channelOptions(slotCh)}
                      </select>

                      <select
                        class="input sim-mgp-pilot-select"
                        data-field="mgp-seat-pilot"
                        data-race-id="${r.id}"
                        data-round="${activeRound.roundNumber}"
                        data-heat="${activeHeat.heatNumber}"
                        data-seat-index="${seatIdx}"
                        aria-label="Pilot for ${esc(roundLabel)} ${esc(heatLabel)} seat ${seatIdx + 1}"
                      >
                        ${seatPilotOptions(e.pilotId)}
                      </select>

                      <div class="sim-mgp-seat-meta">
                        ${
                          hasResult
                            ? `<span class="sim-mgp-seat-synced mono" title="Uploaded to MultiGP (${e.totalLaps ?? 0} laps, total ${e.totalTime ? `${e.totalTime.toFixed(2)}s` : "—"})">
                                <span class="status-dot is-up"></span>
                                <span>${esc(resultSummary)}</span>
                              </span>`
                            : ""
                        }
                        <button
                          type="button"
                          class="btn btn-xs btn-ghost sim-mgp-seat-icon-btn sim-btn-delete"
                          data-action="mgp-delete-seat"
                          data-race-id="${r.id}"
                          data-round="${activeRound.roundNumber}"
                          data-heat="${activeHeat.heatNumber}"
                          data-seat-index="${seatIdx}"
                          ${entries.length <= 1 ? "disabled" : ""}
                          title="${entries.length <= 1 ? "At least 1 VTX seat is required" : "Delete VTX seat"}"
                          aria-label="Delete seat"
                        >
                          ${icons.trash(12)}
                        </button>
                      </div>
                    </div>`;
                })
                .join("");

              rightDetailHtml = `
                <div class="sim-mgp-heat-detail">
                  <div class="sim-mgp-heat-head">
                    <div class="sim-mgp-heat-title-wrap">
                      <strong>${esc(roundLabel)} · ${esc(heatLabel)}</strong>
                      <span class="muted mono">${occInActive}/${entries.length} VTX seats assigned</span>
                    </div>
                    <div class="sim-mgp-heat-actions">
                      ${
                        entries.length < 8
                          ? `<button
                              type="button"
                              class="btn btn-xs btn-ghost"
                              data-action="mgp-add-seat"
                              data-race-id="${r.id}"
                              data-round="${activeRound.roundNumber}"
                              data-heat="${activeHeat.heatNumber}"
                              title="Add VTX slot to ${esc(heatLabel)}"
                            >
                              ${icons.plus(11)}<span>Seat</span>
                            </button>`
                          : ""
                      }
                    </div>
                  </div>
                  <div class="sim-mgp-seats-list">
                    ${seatRowsHtml}
                  </div>
                </div>`;
            }

            splitBodyHtml = `
              <div class="sim-mgp-split-layout">
                <div class="sim-mgp-round-rail">
                  <div class="sim-mgp-rail-head">
                    <div class="sim-mgp-round-title">
                      <strong>${esc(roundLabel)}</strong>
                      <span class="muted mono">${activeHeats.length} ${activeHeats.length === 1 ? "heat" : "heats"}</span>
                    </div>
                    <div class="sim-mgp-round-actions">
                      <button
                        type="button"
                        class="btn btn-xs btn-ghost"
                        data-action="mgp-add-heat"
                        data-race-id="${r.id}"
                        data-round="${activeRound.roundNumber}"
                        title="Add heat to ${esc(roundLabel)}"
                      >
                        ${icons.plus(11)}<span>Heat</span>
                      </button>
                      <button
                        type="button"
                        class="btn btn-xs btn-ghost sim-mgp-seat-icon-btn sim-btn-delete"
                        data-action="mgp-delete-round"
                        data-race-id="${r.id}"
                        data-round="${activeRound.roundNumber}"
                        title="Delete ${esc(roundLabel)}"
                        aria-label="Delete ${esc(roundLabel)}"
                      >
                        ${icons.trash(12)}
                      </button>
                    </div>
                  </div>
                  <div class="sim-mgp-rail-list" data-mgp-rail-key="${r.id}:${activeRound.roundNumber}">
                    ${railItemsHtml}
                  </div>
                </div>
                ${rightDetailHtml}
              </div>`;
          }

          const overallHtml = hasOverall
            ? `<div class="sim-mgp-podium-list">
                ${(r.overallResults ?? [])
                  .map(
                    (o) =>
                      `<span class="badge mono">#${o.orderNumber} ${esc(o.userName || `Pilot ${o.pilotId}`)}</span>`
                  )
                  .join("")}
              </div>`
            : `<p class="note">No overall podium standings uploaded yet.</p>`;

          expandedHtml = `
            <div class="sim-mgp-inspector" data-testid="sim-mgp-editor-${r.id}">
              <div class="sim-mgp-inspector-pane">
                <div class="sim-mgp-inspector-head">
                  <div class="sim-mgp-pane-title-group">
                    <strong>Pilot roster</strong>
                    <span class="badge mono">${checkedInEntries.length} checked in</span>
                    <span class="muted sim-mgp-drag-hint">Drag pilots onto VTX seats below, or drag seats by their grip handle to swap.</span>
                  </div>
                  <div class="sim-mgp-pane-actions">
                    <div class="sim-mgp-walkup-group">
                      <input
                        type="text"
                        class="input sim-mgp-walkup-input"
                        placeholder="Add walk-up callsign…"
                        value="${esc(walkupVal)}"
                        data-field="mgp-walkup-name"
                        data-race-id="${r.id}"
                        aria-label="New walk-up pilot callsign"
                      />
                      <button
                        type="button"
                        class="btn btn-xs btn-ghost"
                        data-action="mgp-add-walkup"
                        data-race-id="${r.id}"
                      >
                        + Add
                      </button>
                    </div>
                    <button
                      type="button"
                      class="btn btn-xs btn-ghost"
                      data-action="mgp-all-pilots"
                      data-race-id="${r.id}"
                      data-enabled="1"
                    >
                      Check in all
                    </button>
                    <button
                      type="button"
                      class="btn btn-xs btn-ghost"
                      data-action="mgp-all-pilots"
                      data-race-id="${r.id}"
                      data-enabled="0"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div class="sim-mgp-pilot-chips">
                  ${checkedInChipsHtml}
                </div>
                ${poolBarHtml}
                ${zippySimBarHtml}
              </div>

              <div class="sim-mgp-inspector-pane">
                <div class="sim-mgp-inspector-head">
                  <div class="sim-mgp-pane-title-group">
                    <strong>Rounds &amp; heats</strong>
                    <span class="badge mono">${rounds.length} ${rounds.length === 1 ? "round" : "rounds"} · ${heatCount} ${heatCount === 1 ? "heat" : "heats"}</span>
                  </div>
                  <div class="sim-mgp-pane-actions">
                    ${
                      isSyncedAny
                        ? `<button
                            type="button"
                            class="btn btn-xs btn-ghost"
                            data-action="mgp-clear-uploads"
                            data-race-id="${r.id}"
                            title="Reset uploaded slot times and podium standings on this simulated race"
                          >
                            Clear uploads
                          </button>`
                        : ""
                    }
                    <button
                      type="button"
                      class="btn btn-xs btn-ghost"
                      data-action="mgp-rebuild-schedule"
                      data-race-id="${r.id}"
                      title="Rebuild balanced heats from the checked-in roster"
                    >
                      Auto-seed heats
                    </button>
                  </div>
                </div>

                ${roundPillsHtml}
                ${splitBodyHtml}
              </div>

              <div class="sim-mgp-inspector-pane">
                <div class="sim-mgp-inspector-head">
                  <div class="sim-mgp-pane-title-group">
                    <strong>Overall standings upload</strong>
                    <span class="sim-mgp-led-inline">
                      <span class="status-dot ${hasOverall ? "is-up" : ""}"></span>
                      <span class="muted mono">${hasOverall ? "Uploaded" : "None"}</span>
                    </span>
                  </div>
                </div>
                ${overallHtml}
              </div>
            </div>`;
        }

        return `
          <div class="sim-mgp-race-group ${expanded ? "is-expanded" : ""}">
            <div class="timer-table-row sim-mgp-race-row" data-race-id="${r.id}">
              <button
                type="button"
                class="detected-timer-id sim-mgp-race-toggle"
                data-action="mgp-toggle-results"
                data-race-id="${r.id}"
                aria-expanded="${expanded ? "true" : "false"}"
                title="${expanded ? `Collapse ${esc(r.name)}` : `Expand ${esc(r.name)}`}"
              >
                <span class="sim-mgp-race-chevron">${expanded ? icons.chevronDown(14) : icons.chevronRight(14)}</span>
                <span class="badge mono">#${r.id}</span>
                <span
                  class="status-dot sim-mgp-race-sync-dot ${isSyncedAny ? "is-up" : ""}"
                  title="${esc(syncTooltip)}"
                  aria-label="${esc(syncTooltip)}"
                ></span>
                <strong class="sim-mgp-race-title">${esc(r.name)}</strong>
              </button>

              <div class="sim-mgp-col-desktop">
                <select
                  class="input"
                  data-field="mgp-race-mode"
                  data-race-id="${r.id}"
                  aria-label="Schedule mode for ${esc(r.name)}"
                >
                  <option value="controlled" ${!isZippyQ ? "selected" : ""}>Controlled</option>
                  <option value="zippyq" ${isZippyQ ? "selected" : ""}>ZippyQ</option>
                </select>
              </div>

              <div class="sim-mgp-col-desktop">
                <select
                  class="input"
                  data-field="mgp-race-scoring"
                  data-race-id="${r.id}"
                  aria-label="MultiGP scoring format for ${esc(r.name)}"
                >
                  ${scoringOptions(r.scoringFormat)}
                </select>
              </div>

              <div class="sim-timer-row-actions sim-mgp-row-actions">
                <button
                  class="btn btn-xs btn-ghost sim-mgp-mobile-icon-btn ${isZippyQ ? "is-zippyq" : ""}"
                  type="button"
                  data-action="mgp-mobile-mode-menu"
                  data-race-id="${r.id}"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  title="Schedule: ${isZippyQ ? "ZippyQ" : "Controlled"}"
                  aria-label="Schedule mode for ${esc(r.name)} (${isZippyQ ? "ZippyQ" : "Controlled"})"
                >
                  ${isZippyQ ? icons.zap(14) : icons.calendar(14)}
                </button>
                <button
                  class="btn btn-xs btn-ghost sim-mgp-mobile-icon-btn"
                  type="button"
                  data-action="mgp-mobile-scoring-menu"
                  data-race-id="${r.id}"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  title="Scoring format: ${esc(formatMultiGPScoring(r.scoringFormat))}"
                  aria-label="MultiGP scoring format for ${esc(r.name)} (${esc(formatMultiGPScoring(r.scoringFormat))})"
                >
                  ${icons.trophy(14)}
                </button>
                <button
                  class="btn btn-sm btn-ghost sim-btn-delete sim-mgp-delete-race-btn"
                  type="button"
                  data-action="mgp-delete-race"
                  data-race-id="${r.id}"
                  title="Delete ${esc(r.name)}"
                  aria-label="Delete ${esc(r.name)}"
                >
                  <span class="sim-mgp-del-icon">${icons.trash(14)}</span>
                  <span class="sim-mgp-del-text">Delete</span>
                </button>
              </div>
            </div>
            ${expandedHtml}
          </div>`;
      })
      .join("");

    const eyeLabel = this.mgpRevealKey ? "Hide API key" : "Reveal API key";

    host.querySelectorAll<HTMLElement>(".sim-mgp-rail-list[data-mgp-rail-key]").forEach((railEl) => {
      const k = railEl.dataset.mgpRailKey;
      if (k) {
        this.mgpRailScrollByKey.set(k, railEl.scrollTop);
      }
    });

    host.innerHTML = `
      ${this.mgpErrorMsg ? `<div class="card"><div class="storage-status-error">${esc(this.mgpErrorMsg)}</div></div>` : ""}

      <div class="card card-flush">
        <div class="card-body">
          <div>
            <div class="option-title">Chapter credentials</div>
            <div class="option-sub">Simulated MultiGP chapter identity and WebService API key used to authenticate race imports and result uploads.</div>
          </div>
          <div class="form-grid sim-mgp-cred-grid">
            <label class="field">
              <span>Chapter name</span>
              <input
                class="input"
                type="text"
                value="${esc(mgp.chapterName)}"
                data-field="mgp-chapter-name"
                aria-label="Simulated chapter name"
              />
            </label>
            <div class="field">
              <span>Chapter API key</span>
              <div class="sim-mgp-key-row">
                <div class="flasher-pass-wrap sim-mgp-key-wrap">
                  <input
                    readonly
                    type="${this.mgpRevealKey ? "text" : "password"}"
                    class="input flasher-pass-input mono"
                    value="${esc(mgp.apiKey)}"
                    data-testid="sim-mgp-api-key"
                    aria-label="Simulated Chapter API key"
                  />
                  <button
                    type="button"
                    class="flasher-pass-toggle"
                    data-action="mgp-toggle-reveal"
                    aria-label="${eyeLabel}"
                    title="${eyeLabel}"
                  >
                    ${this.mgpRevealKey ? icons.eyeOff(15) : icons.eye(15)}
                  </button>
                </div>
                <button class="btn btn-sm btn-ghost" type="button" data-action="mgp-copy-key">${this.mgpCopiedKey ? "Copied" : "Copy"}</button>
                <button class="btn btn-sm btn-ghost" type="button" data-action="mgp-regen-key">Regenerate</button>
              </div>
            </div>
          </div>
        </div>
        <div class="rules-foot">
          <p class="note">Chapter ID <span class="mono">#${mgp.chapterId || 1042}</span> · Restoring defaults resets the chapter roster, races, and simulated API key.</p>
          <button class="btn btn-ghost btn-sm" type="button" data-action="mgp-reset">Restore defaults</button>
        </div>
      </div>

      <div class="card card-flush sim-mgp-races-card">
        <div class="card-head sim-mgp-card-head">
          <div>
            <div class="option-title">Chapter races</div>
            <div class="option-sub">Click any race row to configure its pilot roster, rounds, heats, VTX seat assignments, or ZippyQ simulation.</div>
          </div>
          <div class="sim-mgp-head-meta">
            <span class="badge mono">${racesList.length} ${racesList.length === 1 ? "race" : "races"}</span>
          </div>
        </div>
        <div class="sim-mgp-table-wrap">
          <div class="slot-table timer-table sim-mgp-table">
            <div class="timer-table-row sim-mgp-race-row timer-table-head">
              <span>Race</span>
              <span>Schedule</span>
              <span>Scoring format</span>
              <span class="num">Actions</span>
            </div>
            ${racesRowsHtml || `<div class="empty-note" style="padding:18px 20px">No simulated MultiGP races scheduled. Create a race below or click "Restore defaults" above.</div>`}
          </div>
        </div>
      </div>

      <div class="card card-flush">
        <div class="card-body">
          <div>
            <div class="option-title">Create chapter race</div>
            <div class="option-sub">Add a new simulated MultiGP event populated with your active simulated pilots.</div>
          </div>
          <div class="form-grid">
            <label class="field">
              <span>Race name</span>
              <input
                class="input"
                type="text"
                placeholder="e.g. Friday Night Qualifier"
                value="${esc(this.mgpNewName)}"
                data-field="mgp-new-name"
              />
            </label>
            <label class="field">
              <span>Scoring format</span>
              <select class="input" data-field="mgp-new-scoring">
                ${scoringOptions(this.mgpNewScoring)}
              </select>
            </label>
          </div>
        </div>
        <div class="rules-foot">
          <p class="note">ZippyQ races simulate pilots checking in and lining up into open seats automatically (green LED means uploaded, and gray LED means no uploads).</p>
          <button class="btn btn-ghost btn-sm" type="button" data-action="mgp-add-race">+ Create race</button>
        </div>
      </div>`;

    const scrollBottomKey = this.mgpPendingScrollBottomKey;
    this.mgpPendingScrollBottomKey = "";
    host.querySelectorAll<HTMLElement>(".sim-mgp-rail-list[data-mgp-rail-key]").forEach((railEl) => {
      const k = railEl.dataset.mgpRailKey ?? "";
      if (!k) return;
      if (k === scrollBottomKey) {
        railEl.scrollTop = railEl.scrollHeight;
        this.mgpRailScrollByKey.set(k, railEl.scrollTop);
      } else if (this.mgpRailScrollByKey.has(k)) {
        railEl.scrollTop = this.mgpRailScrollByKey.get(k)!;
        this.mgpRailScrollByKey.set(k, railEl.scrollTop);
      }
    });
  }
}
