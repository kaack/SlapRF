import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { usbPool } from "../services/timer_console";
import { timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { DetectedTimer, isLapRFMode, isRotorHazardMode, TrackNode } from "../types/models";
import { renderSectionCapsuleIcon } from "./markup";

/**
 * Interactive course-line ("---O---O---O---O---") Track editor:
 *   - Dropping an unassigned timer onto the track line places that timer at that position.
 *   - Dragging a timer along the track line reorders the course.
 *   - Dragging a timer off the track line into the Unassigned Timers box removes it from the track
 *     when the mouse is released (keeping the dashed slot on the track until drop).
 *   - Below each timer on the track line sits a checkered flag icon button (active on the
 *     start timer, muted on intermediate timers); clicking it sets that timer as the start timer.
 */
export function isTrackTimerActive(store: AppStore, d?: DetectedTimer, node?: TrackNode): boolean {
  if (Boolean(d ? d.online : node?.online)) {
    return true;
  }
  if (
    isLapRFMode(store.timingHardwareMode) ||
    isRotorHazardMode(store.timingHardwareMode) ||
    d?.firmwareVersion === "LapRF" ||
    node?.firmwareVersion === "LapRF" ||
    d?.firmwareVersion === "RotorHazard" ||
    node?.firmwareVersion === "RotorHazard"
  ) {
    return false;
  }
  const connected = usbPool.connectedConsoles();
  if (connected.length === 0) {
    return false;
  }
  const fp = (d?.fingerprint || "").toUpperCase();
  if (fp) {
    const direct = usbPool.findByFingerprint(fp);
    if (direct && direct.connected && !direct.lastStatus?.emergencyMode) {
      return true;
    }
  }
  const hub = usbPool.hubConsole();
  if (hub && hub.connected && !hub.lastStatus?.emergencyMode) {
    if (d?.isHub) {
      return true;
    }
    if (fp && Array.isArray(hub.lastStatus?.spokes)) {
      const sp = hub.lastStatus!.spokes!.find((s) => (s.fp || "").toUpperCase() === fp);
      if (sp) {
        const msAgo = sp.msAgo !== undefined && sp.msAgo >= 0x80000000 ? 0 : sp.msAgo;
        return (sp.frames ?? 0) > 0 && (msAgo === undefined || msAgo < 5000);
      }
    }
    return Boolean(d ? d.online : node?.online);
  }
  return false;
}

export interface TrackEditorOptions {
  readOnly?: () => boolean;
}

export class TrackEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly isReadOnlyFn: () => boolean;
  private isDragging = false;
  private lastRenderedHtml = "";
  private trackResizeObserver: ResizeObserver | null = null;
  private trackScrollCueRaf = 0;
  private trackMomentumRaf = 0;
  private suppressNextTrackClick = false;
  private modeOverride: "single" | "multi" | null = null;
  private seenMultiNodes = false;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, opts: TrackEditorOptions = {}) {
    super(el);
    this.store = store;
    this.api = api;
    this.isReadOnlyFn = opts.readOnly ?? (() => false);

    this.listen(el, "change", (e) => {
      if (this.isReadOnlyFn()) return;
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLSelectElement && target.hasAttribute("data-single-timer-select")) {
        const nextTimerId = Number(target.value) || 0;
        if (nextTimerId > 0) {
          void this.selectSingleTimer(nextTimerId);
        }
      }
    });

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const modeBtn = target.closest<HTMLButtonElement>("[data-track-mode]");
      if (modeBtn && !this.isReadOnlyFn()) {
        e.preventDefault();
        e.stopPropagation();
        const nextMode = modeBtn.dataset.trackMode;
        if (nextMode === "single") {
          void this.switchToSingleTimerMode();
        } else if (nextMode === "multi") {
          this.modeOverride = "multi";
          this.seenMultiNodes = true;
          this.render(true);
        }
        return;
      }
      const assignSingleBtn = target.closest<HTMLButtonElement>("[data-assign-single-timer]");
      if (assignSingleBtn && !this.isReadOnlyFn()) {
        e.preventDefault();
        e.stopPropagation();
        const nextTimerId = Number(assignSingleBtn.dataset.assignSingleTimer) || 0;
        if (nextTimerId > 0) {
          void this.selectSingleTimer(nextTimerId);
        }
        return;
      }
      const scrollBtn = target.closest<HTMLButtonElement>("[data-track-scroll]");
      if (scrollBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelTrackMomentum();
        const scrollEl = this.el.querySelector<HTMLElement>(".gate-track-scroll");
        if (scrollEl) {
          const dir = Number(scrollBtn.dataset.trackScroll) || 1;
          const step = Math.max(120, Math.round(scrollEl.clientWidth * 0.68));
          try {
            scrollEl.scrollBy({ left: dir * step, behavior: "smooth" });
          } catch {
            scrollEl.scrollLeft += dir * step;
          }
        }
        return;
      }
      if (this.suppressNextTrackClick) {
        this.suppressNextTrackClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.isReadOnlyFn()) return;
      const makeStartBtn = target.closest<HTMLElement>("[data-make-start]");
      if (makeStartBtn) {
        e.stopPropagation();
        void this.makeStart(Number(makeStartBtn.dataset.makeStart));
        return;
      }
      const deleteTimerBtn = target.closest<HTMLElement>("[data-delete-timer]");
      if (deleteTimerBtn) {
        e.preventDefault();
        e.stopPropagation();
        const timerId = Number(deleteTimerBtn.dataset.deleteTimer);
        const fp = deleteTimerBtn.dataset.deleteFp || "";
        const label = deleteTimerBtn.dataset.deleteLabel || "";
        void this.api.deleteTimer(timerId, fp, label);
        return;
      }
    });

    this.listen(el, "pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-track-scroll], [data-make-start], [data-delete-timer], [data-track-mode], [data-single-timer-select], [data-assign-single-timer]")) {
        return;
      }

      if (!this.isReadOnlyFn()) {
        const trayTimerEl = target.closest<HTMLElement>(".unassigned-timer-token[data-timer-id]");
        if (trayTimerEl) {
          this.beginTrayTimerDrag(e, trayTimerEl);
          return;
        }

        const interactiveNodePart = target.closest<HTMLElement>(
          ".gate-node-circle, .gate-node-top"
        );
        const nodeEl = interactiveNodePart?.closest<HTMLElement>(".gate-line-item[data-gate]");
        if (nodeEl) {
          this.beginTrackNodeInteraction(e, nodeEl);
          return;
        }
      }

      const scrollEl = target.closest<HTMLElement>(".gate-track-scroll");
      if (scrollEl && e.pointerType === "mouse" && scrollEl.scrollWidth > scrollEl.clientWidth + 4) {
        this.beginTrackPan(e, scrollEl);
      }
    });

    this.listen(window, "resize", () => this.scheduleSyncTrackScrollCues());
    if (typeof ResizeObserver !== "undefined") {
      this.trackResizeObserver = new ResizeObserver(() => this.scheduleSyncTrackScrollCues());
      this.trackResizeObserver.observe(this.el);
    }

    const refreshIfIdle = () => {
      const active = document.activeElement;
      const editing =
        (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
        this.el.contains(active);
      if (!editing && !this.isDragging) this.render();
    };

    const unsubStore = store.subscribe(["config", "status", "practice", "race", "rules"], refreshIfIdle);
    const unsubPool = usbPool.onChange(refreshIfIdle);
    const unsubSlots = usbPool.slots.map((c) =>
      c.subscribe({
        onConnect: refreshIfIdle,
        onStatus: refreshIfIdle,
        onDisconnect: refreshIfIdle,
      })
    );
    this.onDispose(() => {
      this.cancelTrackMomentum();
      if (this.trackScrollCueRaf) {
        window.cancelAnimationFrame(this.trackScrollCueRaf);
        this.trackScrollCueRaf = 0;
      }
      if (this.trackResizeObserver) {
        this.trackResizeObserver.disconnect();
        this.trackResizeObserver = null;
      }
      unsubStore();
      unsubPool();
      unsubSlots.forEach((fn) => fn());
    });
    this.render();
  }

  private isTimerActive(d?: DetectedTimer, node?: TrackNode): boolean {
    return isTrackTimerActive(this.store, d, node);
  }

  private get orderedNodes(): TrackNode[] {
    return [...this.store.nodes].sort((a, b) => a.trackOrder - b.trackOrder);
  }

  private get detectedTimers(): DetectedTimer[] {
    if (this.store.detectedTimers.length > 0) {
      return [...this.store.detectedTimers].sort((a, b) => a.timerId - b.timerId);
    }
    return this.store.nodes
      .filter((p) => (p.assignedTimerId ?? p.gateId) > 0)
      .map((p) => ({
        timerId: p.assignedTimerId ?? p.gateId,
        timerLabel: p.timerLabel ?? "",
        color: p.color,
        isHub: false,
        batteryMv: p.batteryMv,
        batteryPct: p.batteryPct,
        noiseFloorDbm: p.noiseFloorDbm,
        online: p.online,
        lastSeenAt: p.lastSeenAt,
      }))
      .sort((a, b) => a.timerId - b.timerId);
  }

  private formatTimerShortCode(timerId: number, detected?: DetectedTimer[], fallbackLabel?: string): string {
    if (timerId <= 0) return "—";
    const list = detected ?? this.detectedTimers;
    const d = list.find((t) => t.timerId === timerId);
    const given = d?.timerLabel?.trim() || fallbackLabel?.trim();
    if (given) {
      if (/^rh(\d+)$/i.test(given)) {
        return `R${given.slice(2)}`.slice(0, 2);
      }
      return given.slice(0, 2);
    }
    if (isRotorHazardMode(this.store.timingHardwareMode)) {
      return `R${Math.max(1, timerId - 1)}`;
    }
    return d?.isHub ? "H1" : `T${Math.max(1, timerId - 1)}`;
  }

  private resolveEffectiveMode(nodes: TrackNode[]): "single" | "multi" {
    if (nodes.length > 1) {
      this.seenMultiNodes = true;
      return "multi";
    }
    if (this.modeOverride === "multi") {
      return "multi";
    }
    if (this.modeOverride === "single") {
      return "single";
    }
    return this.seenMultiNodes ? "multi" : "single";
  }

  private pickPreferredSingleTimer(nodes: TrackNode[], detected: DetectedTimer[]): DetectedTimer | undefined {
    const onlineHub = detected.find((d) => d.isHub && this.isTimerActive(d));
    if (onlineHub) return onlineHub;
    const startNode = nodes.find((n) => n.role === "START_FINISH") ?? nodes[0];
    const startTimerId = startNode?.assignedTimerId ?? 0;
    if (startTimerId > 0) {
      const matched = detected.find((d) => d.timerId === startTimerId);
      if (matched) return matched;
    }
    const anyHub = detected.find((d) => d.isHub);
    if (anyHub) return anyHub;
    return detected.find((d) => this.isTimerActive(d)) ?? detected[0];
  }

  private async switchToSingleTimerMode(): Promise<void> {
    this.modeOverride = "single";
    this.seenMultiNodes = false;
    const nodes = this.orderedNodes;
    const detected = this.detectedTimers;
    const preferred = this.pickPreferredSingleTimer(nodes, detected);

    if (nodes.length > 1) {
      this.isDragging = true;
      try {
        const keepNode = nodes.find((n) => n.role === "START_FINISH") ?? nodes[0];
        for (const n of nodes) {
          if (n.gateId !== keepNode.gateId) {
            await this.api.removeTrackNode(n.gateId);
          }
        }
        const refreshedKeep = this.store.node(keepNode.gateId) ?? keepNode;
        const targetTimerId = preferred?.timerId ?? refreshedKeep.assignedTimerId ?? 0;
        if (
          refreshedKeep.role !== "START_FINISH" ||
          (targetTimerId > 0 && refreshedKeep.assignedTimerId !== targetTimerId)
        ) {
          await this.save(refreshedKeep, {
            role: "START_FINISH",
            assignedTimerId: targetTimerId > 0 ? targetTimerId : refreshedKeep.assignedTimerId,
          });
        }
      } finally {
        this.isDragging = false;
      }
    } else if (nodes.length === 0 && preferred) {
      await this.api.addTrackNode("", preferred.timerId, 0);
    }
    this.render(true);
  }

  private async selectSingleTimer(timerId: number): Promise<void> {
    this.modeOverride = "single";
    this.seenMultiNodes = false;
    const nodes = this.orderedNodes;
    if (nodes.length === 0) {
      await this.api.addTrackNode("", timerId, 0);
    } else {
      const keepNode = nodes.find((n) => n.role === "START_FINISH") ?? nodes[0];
      for (const n of nodes) {
        if (n.gateId !== keepNode.gateId) {
          await this.api.removeTrackNode(n.gateId);
        }
      }
      const refreshedKeep = this.store.node(keepNode.gateId) ?? keepNode;
      await this.save(refreshedKeep, { role: "START_FINISH", assignedTimerId: timerId });
    }
    this.render(true);
  }

  private renderSingleTimerStage(
    node: TrackNode | undefined,
    detected: DetectedTimer[],
    readOnly: boolean
  ): string {
    const assignedId = node?.assignedTimerId ?? 0;
    const hasTimer = Boolean(node && assignedId > 0);
    const tiedTimer = hasTimer ? detected.find((d) => d.timerId === assignedId) : undefined;
    const shortCode = hasTimer ? this.formatTimerShortCode(assignedId, detected, node?.timerLabel) : "—";
    const color = hasTimer ? timerColor(this.store, assignedId) : "#64748b";
    const isOnline = hasTimer ? this.isTimerActive(tiedTimer, node) : false;
    const preferred = !hasTimer ? this.pickPreferredSingleTimer([], detected) : undefined;
    const preferredCode = preferred ? this.formatTimerShortCode(preferred.timerId, detected, preferred.timerLabel) : "";

    const puckHtml = node
      ? `<div
          class="gate-line-item is-start is-single-mode ${hasTimer ? "has-timer" : "is-empty-gate"} ${hasTimer && !isOnline ? "is-offline" : ""}"
          data-gate="${node.gateId}"
          data-assigned-timer="${assignedId}"
          data-timer-color="${color}"
          style="--c:${color}"
        >
          <span class="gate-node-circle ${hasTimer ? (isOnline ? "is-filled" : "is-filled is-offline") : "is-unassigned"}">
            ${hasTimer ? `<span class="gate-node-timer-code mono">${esc(shortCode)}</span>` : `<span class="gate-node-empty-label"></span>`}
          </span>
        </div>`
      : `<div class="gate-line-item is-empty-placeholder is-single-mode" data-empty-placeholder>
          <span class="gate-node-circle is-unassigned is-empty-slot-circle">
            <span class="gate-node-empty-label"></span>
          </span>
        </div>`;

    const copyHtml = hasTimer
      ? `<div class="gate-single-timer-copy">
          <strong>Start / Finish Gate · ${esc(shortCode)}${tiedTimer?.isHub ? " (Hub)" : ""}${isOnline ? "" : " · Offline"}</strong>
          <span class="gate-single-timer-sub"><span class="rc-lbl-full">Every pass over ${esc(shortCode)} counts a full lap. Switch to Multiple Timers above only if you place extra split gates on the course.</span><span class="rc-lbl-short">Counts full laps at ${esc(shortCode)}.</span></span>
        </div>`
      : preferred && !readOnly
        ? `<div class="gate-single-timer-copy">
            <strong>No Start / Finish timer assigned yet</strong>
            <span class="gate-single-timer-sub">Assign ${esc(preferredCode)} as your Start / Finish gate in one click.</span>
          </div>`
        : `<div class="gate-single-timer-copy">
            <strong>No timer connected yet</strong>
            <span class="gate-single-timer-sub">Connect a timer in the top bar and it will bind automatically as Start / Finish.</span>
          </div>`;

    const actionHtml = readOnly
      ? ""
      : !hasTimer && preferred
        ? `<button type="button" class="btn btn-armed btn-xs" data-assign-single-timer="${preferred.timerId}">
             ${icons.checkered(13)}<span>Use ${esc(preferredCode)}</span>
           </button>`
        : detected.length > 1
          ? `<label class="gate-single-timer-picker">
               <span class="rc-lbl-full">Timer</span>
               <select class="input input-sm gate-single-timer-select" data-single-timer-select aria-label="Start / Finish timer">
                 ${detected
                   .map((d) => {
                     const code = this.formatTimerShortCode(d.timerId, detected, d.timerLabel);
                     const roleBit = d.isHub ? " (Hub)" : "";
                     const offlineBit = this.isTimerActive(d) ? "" : " · Offline";
                     return `<option value="${d.timerId}" ${d.timerId === assignedId ? "selected" : ""}>${esc(code + roleBit + offlineBit)}</option>`;
                   })
                   .join("")}
               </select>
             </label>`
          : "";

    return `
      <div class="gate-single-timer-card" data-single-timer-card>
        <div class="gate-single-timer-main">
          ${puckHtml}
          ${copyHtml}
        </div>
        ${actionHtml ? `<div class="gate-single-timer-actions">${actionHtml}</div>` : ""}
      </div>`;
  }

  private render(force = false): void {
    const readOnly = this.isReadOnlyFn();
    const nodes = this.orderedNodes;
    const detected = this.detectedTimers;
    const assignedTimerIds = new Set(
      nodes.map((n) => n.assignedTimerId ?? 0).filter((id) => id > 0)
    );
    const unassignedTimers = detected.filter((d) => !assignedTimerIds.has(d.timerId));
    const effectiveMode = this.resolveEffectiveMode(nodes);
    const isSingle = effectiveMode === "single";

    const modeSwitcherHtml = readOnly
      ? ""
      : `<div class="segmented gate-track-mode-seg" role="tablist" aria-label="Track timer layout" data-track-mode-toggle>
          <button
            type="button"
            role="tab"
            aria-selected="${isSingle ? "true" : "false"}"
            class="${isSingle ? "is-active" : ""}"
            data-track-mode="single"
          ><span class="rc-lbl-full">Single Timer (Start / Finish)</span><span class="rc-lbl-short">1 Timer</span></button>
          <button
            type="button"
            role="tab"
            aria-selected="${!isSingle ? "true" : "false"}"
            class="${!isSingle ? "is-active" : ""}"
            data-track-mode="multi"
          ><span class="rc-lbl-full">Multiple Timers (Splits)</span><span class="rc-lbl-short">Splits</span></button>
        </div>`;

    const html = `
      <div class="gate-track-stage ${readOnly ? "is-readonly-track" : ""} ${isSingle ? "is-single-timer-stage" : "is-multi-timer-stage"}">
        <div class="gate-track-header">
          ${modeSwitcherHtml}
          <span class="gate-track-caption">
            ${
              readOnly
                ? "Recorded track order for this closed race · reopen the race to modify timers or gate order"
                : isSingle
                  ? ""
                  : "Drag timers onto the line to add them to the track · drag along the line to reorder · drag into Unassigned timers to remove"
            }
          </span>
        </div>

        ${
          isSingle
            ? this.renderSingleTimerStage(nodes[0], detected, readOnly)
            : `<div class="gate-track-scroll-shell" data-track-scroll-shell>
                <button
                  type="button"
                  class="pilot-picker-cue gate-track-cue is-left"
                  data-track-scroll="-1"
                  aria-label="Scroll track timers left"
                  title="More timers left"
                  hidden
                >${icons.chevronLeft(16)}</button>
                <div class="gate-track-scroll" data-track-dropzone>
                  <div class="gate-track-line ${nodes.length === 0 ? "is-empty-line" : ""}" data-track-line role="list" aria-label="Course timer order">
                    ${
                      nodes.length === 0
                        ? this.renderEmptyTimelinePlaceholder()
                        : nodes
                            .map((n, idx) =>
                              this.renderTrackNode(
                                n,
                                idx,
                                nodes,
                                detected
                              )
                            )
                            .join("")
                    }
                  </div>
                </div>
                <button
                  type="button"
                  class="pilot-picker-cue gate-track-cue is-right"
                  data-track-scroll="1"
                  aria-label="Scroll track timers right"
                  title="More timers right"
                  hidden
                >${icons.chevronRight(16)}</button>
              </div>
              ${readOnly ? "" : this.renderUnassignedTray(unassignedTimers)}`
        }
      </div>
    `;
    if (!force && html === this.lastRenderedHtml) {
      this.scheduleSyncTrackScrollCues();
      return;
    }
    const prevScrollLeft = this.el.querySelector<HTMLElement>(".gate-track-scroll")?.scrollLeft ?? 0;
    const prevTrayScrollLeft =
      this.el.querySelector<HTMLElement>(".gate-unassigned-list")?.scrollLeft ?? 0;
    this.lastRenderedHtml = html;
    this.el.innerHTML = html;

    const nextScrollEl = this.el.querySelector<HTMLElement>(".gate-track-scroll");
    if (nextScrollEl) {
      if (prevScrollLeft > 0) {
        nextScrollEl.scrollLeft = prevScrollLeft;
      }
      nextScrollEl.addEventListener(
        "scroll",
        () => this.scheduleSyncTrackScrollCues(),
        { passive: true }
      );
    }
    const nextTrayListEl = this.el.querySelector<HTMLElement>(".gate-unassigned-list");
    if (nextTrayListEl && prevTrayScrollLeft > 0) {
      nextTrayListEl.scrollLeft = prevTrayScrollLeft;
    }
    this.syncTrackScrollCues();
    this.scheduleSyncTrackScrollCues();
  }

  private cancelTrackMomentum(): void {
    if (this.trackMomentumRaf) {
      window.cancelAnimationFrame(this.trackMomentumRaf);
      this.trackMomentumRaf = 0;
    }
    this.el.querySelector<HTMLElement>(".gate-track-scroll")?.classList.remove("is-dragging");
  }

  private startTrackMomentum(scrollEl: HTMLElement, initialVelocityX: number): void {
    let velocityX = initialVelocityX;
    if (Math.abs(velocityX) < 0.12) return;
    this.cancelTrackMomentum();
    let lastFrameTime = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, Math.max(1, now - lastFrameTime));
      lastFrameTime = now;
      const prev = scrollEl.scrollLeft;
      scrollEl.scrollLeft -= velocityX * dt;
      velocityX *= Math.pow(0.95, dt / 16);
      if (Math.abs(velocityX) >= 0.05 && Math.abs(scrollEl.scrollLeft - prev) > 0.08) {
        this.trackMomentumRaf = window.requestAnimationFrame(step);
      } else {
        this.trackMomentumRaf = 0;
      }
    };
    this.trackMomentumRaf = window.requestAnimationFrame(step);
  }

  private scheduleSyncTrackScrollCues(): void {
    if (this.trackScrollCueRaf) return;
    this.trackScrollCueRaf = window.requestAnimationFrame(() => {
      this.trackScrollCueRaf = 0;
      this.syncTrackScrollCues();
    });
  }

  private syncTrackScrollCues(): void {
    const shell = this.el.querySelector<HTMLElement>("[data-track-scroll-shell]");
    const scrollEl = this.el.querySelector<HTMLElement>(".gate-track-scroll");
    const leftCue = this.el.querySelector<HTMLButtonElement>('[data-track-scroll="-1"]');
    const rightCue = this.el.querySelector<HTMLButtonElement>('[data-track-scroll="1"]');
    if (!shell || !scrollEl || !leftCue || !rightCue) return;
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    const canLeft = maxScroll > 4 && scrollEl.scrollLeft > 4;
    const canRight = maxScroll > 4 && scrollEl.scrollLeft < maxScroll - 4;
    leftCue.hidden = !canLeft;
    rightCue.hidden = !canRight;
    shell.classList.toggle("can-scroll-left", canLeft);
    shell.classList.toggle("can-scroll-right", canRight);
  }

  private beginTrackPan(downEvent: PointerEvent, scrollEl: HTMLElement): void {
    this.cancelTrackMomentum();
    const pointerId = downEvent.pointerId;
    const downX = downEvent.clientX;
    const downY = downEvent.clientY;
    const downScrollLeft = scrollEl.scrollLeft;
    let lastX = downX;
    let lastMoveTime = performance.now();
    let velocityX = 0;
    let dragged = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - downX;
      const dy = ev.clientY - downY;
      if (!dragged) {
        if (Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy)) {
          dragged = true;
          this.suppressNextTrackClick = true;
          scrollEl.classList.add("is-dragging");
        }
      }
      if (dragged) {
        const now = performance.now();
        const dt = Math.max(1, now - lastMoveTime);
        const instVel = (ev.clientX - lastX) / dt;
        velocityX = velocityX * 0.35 + instVel * 0.65;
        lastX = ev.clientX;
        lastMoveTime = now;
        scrollEl.scrollLeft = downScrollLeft - dx;
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      scrollEl.classList.remove("is-dragging");
      if (dragged) {
        if (performance.now() - lastMoveTime > 75) velocityX = 0;
        this.startTrackMomentum(scrollEl, velocityX);
        window.setTimeout(() => {
          this.suppressNextTrackClick = false;
        }, 50);
      } else {
        this.suppressNextTrackClick = false;
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    window.addEventListener("pointercancel", onUp, { passive: true });
  }

  private renderEmptyTimelinePlaceholder(): string {
    return `
      <div class="gate-line-item is-empty-placeholder" data-empty-placeholder role="listitem">
        <div class="gate-line-track-seg is-before is-dashed-seg"></div>
        <div class="gate-line-track-seg is-after is-dashed-seg"></div>
        <div class="gate-node-top">
          <span class="gate-node-order mono">#1</span>
        </div>
        <div class="gate-node-circle is-unassigned is-empty-slot-circle">
          <span class="gate-node-empty-label" data-empty-circle-label></span>
        </div>
        <span class="gate-node-start-btn is-placeholder-flag" aria-hidden="true">${icons.checkered(13)}</span>
      </div>`;
  }

  private renderTrackNode(
    node: TrackNode,
    index: number,
    allNodes: TrackNode[],
    detected: DetectedTimer[]
  ): string {
    const total = allNodes.length;
    const isStart = node.role === "START_FINISH";
    const assignedId = node.assignedTimerId ?? 0;
    const hasTimer = assignedId > 0;
    const tiedTimer = detected.find((d) => d.timerId === assignedId);
    const shortCode = this.formatTimerShortCode(assignedId, detected, node.timerLabel);
    const isHubGate = hasTimer && tiedTimer?.isHub === true;
    const isLapRF =
      isLapRFMode(this.store.timingHardwareMode) ||
      tiedTimer?.firmwareVersion === "LapRF" ||
      node.firmwareVersion === "LapRF";
    const isRH =
      isRotorHazardMode(this.store.timingHardwareMode) ||
      tiedTimer?.firmwareVersion === "RotorHazard" ||
      node.firmwareVersion === "RotorHazard";
    const roleSub = hasTimer
      ? isLapRF
        ? "LPF"
        : isRH
          ? "RH"
          : isHubGate
            ? "HUB"
            : "SPK"
      : "EMPTY";
    const color = hasTimer ? timerColor(this.store, assignedId) : "#64748b";

    const lastNode = allNodes[(total - 1 + total) % total];
    const lastAssignedId = lastNode?.assignedTimerId ?? 0;
    const lastColor = lastAssignedId > 0 ? timerColor(this.store, lastAssignedId) : "#64748b";

    const nextNode = allNodes[(index + 1) % total];
    const nextAssignedId = nextNode?.assignedTimerId ?? 0;
    const nextColor = nextAssignedId > 0 ? timerColor(this.store, nextAssignedId) : "#64748b";

    const isOnline = this.isTimerActive(tiedTimer, node);
    const sectionTag = `S${index + 1}`;
    const wrapSectionTag = `S${total}`;

    return `
      <div
        class="gate-line-item ${isStart ? "is-start" : ""} ${hasTimer ? "has-timer" : "is-empty-gate"} ${hasTimer && !isOnline ? "is-offline" : ""}"
        data-gate="${node.gateId}"
        data-assigned-timer="${assignedId}"
        data-timer-color="${color}"
        style="--c:${color}"
        role="listitem"
      >
        <div class="gate-line-track-seg is-before"></div>
        <div class="gate-line-track-seg is-after"></div>

        <span
          class="gate-line-sec-pill is-leading sec-id-badge mono"
          style="--c1:${lastColor};--c2:${color}"
          title="Section ${wrapSectionTag} (wrapping from #${total} into #1)"
        >
          ${renderSectionCapsuleIcon(lastColor, color)}
          <span class="sec-pill-text">${wrapSectionTag}</span>
        </span>

        <span
          class="gate-line-sec-pill is-trailing sec-id-badge mono"
          style="--c1:${color};--c2:${nextColor}"
          title="Section ${sectionTag}"
        >
          ${renderSectionCapsuleIcon(color, nextColor)}
          <span class="sec-pill-text">${sectionTag}</span>
        </span>

        <div class="gate-node-top">
          <span class="gate-node-order mono">#${index + 1}</span>
        </div>

        <button
          type="button"
          class="gate-node-circle ${hasTimer ? (isOnline ? "is-filled" : "is-filled is-offline") : "is-unassigned"}"
          aria-label="Track #${index + 1}: ${esc(shortCode)}${isOnline ? "" : " (Offline)"}"
          title="${hasTimer && !isOnline ? `${esc(shortCode)} is on the track but not currently connected · ` : ""}Drag left/right to reorder · Drag down to Unassigned timers to remove from track"
        >
          ${
            hasTimer
              ? `<span class="gate-node-timer-code mono">${esc(shortCode)}</span>`
              : `<span class="gate-node-empty-label"></span>`
          }
        </button>

        <button
          type="button"
          class="gate-node-start-btn ${isStart ? "is-active" : ""}"
          data-make-start="${node.gateId}"
          aria-pressed="${isStart}"
          title="${isStart ? "Start timer (laps are counted here)" : "Set as start timer"}"
          aria-label="${isStart ? `${esc(shortCode)} is the start timer` : `Set ${esc(shortCode)} as start timer`}"
        >${icons.checkered(13)}</button>
      </div>`;
  }

  private renderUnassignedTray(unassigned: DetectedTimer[]): string {
    return `
      <div class="gate-unassigned-tray" data-unassigned-tray>
        <div class="gate-unassigned-label">
          <span class="gate-unassigned-title">Unassigned timers</span>
          <span class="gate-unassigned-hint">
            ${
              unassigned.length > 0
                ? "Drag a timer onto the track line above to place it on the track"
                : "All timers are on the track · drag a timer off the line into this box to remove it from the track"
            }
          </span>
        </div>
        <div class="gate-unassigned-list">
          ${
            unassigned.length > 0
              ? unassigned.map((d) => this.renderTrayTimer(d)).join("")
              : `<span class="gate-unassigned-empty-chip">Drop a timer here to remove it from the track</span>`
          }
        </div>
      </div>`;
  }

  private renderTrayTimer(d: DetectedTimer): string {
    const color = timerColor(this.store, d.timerId);
    const timerName = this.formatTimerShortCode(d.timerId, [d], d.timerLabel);
    const isOnline = this.isTimerActive(d);
    const readOnly = this.isReadOnlyFn();
    return `
      <button
        type="button"
        class="unassigned-timer-token gate-node-circle is-filled ${isOnline ? "" : "is-offline"}"
        data-timer-id="${d.timerId}"
        style="--c:${color}"
        aria-label="Unassigned timer ${esc(timerName)}${isOnline ? "" : " (Offline)"}"
        title="${esc(timerName)} · Drag onto the track line above to place on the track"
      >
        <span class="gate-node-timer-code mono">${esc(timerName)}</span>
        ${
          !isOnline && !readOnly
            ? `<span
                role="button"
                tabindex="0"
                class="unassigned-puck-dismiss"
                data-delete-timer="${d.timerId}"
                data-delete-fp="${esc(d.fingerprint || "")}"
                data-delete-label="${esc(timerName)}"
                title="Remove disconnected timer ${esc(timerName)}"
                aria-label="Remove disconnected timer ${esc(timerName)}"
              >${icons.close(10)}</span>`
            : ""
        }
      </button>`;
  }

  private async removeTrackNode(nodeId: number): Promise<void> {
    this.isDragging = true;
    try {
      await this.api.removeTrackNode(nodeId);
    } finally {
      this.isDragging = false;
      this.render(true);
    }
  }

  private async makeStart(nodeId: number): Promise<void> {
    const node = this.store.node(nodeId);
    if (!node || node.role === "START_FINISH") return;
    await this.save(node, { role: "START_FINISH" });
  }

  private createInsertionPreviewSlot(timerId: number, color: string): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "gate-line-item is-drop-slot is-insert-preview";
    slot.dataset.timerColor = color;
    slot.style.setProperty("--c", color);
    slot.innerHTML = `
      <div class="gate-line-track-seg is-before"></div>
      <div class="gate-line-track-seg is-after"></div>
      <span class="gate-line-sec-pill is-leading sec-id-badge mono" style="--c1:${color};--c2:${color}">
        ${renderSectionCapsuleIcon(color, color)}
        <span class="sec-pill-text">S1</span>
      </span>
      <span class="gate-line-sec-pill is-trailing sec-id-badge mono" style="--c1:${color};--c2:${color}">
        ${renderSectionCapsuleIcon(color, color)}
        <span class="sec-pill-text">S1</span>
      </span>
      <div class="gate-node-top">
        <span class="gate-node-order mono">#1</span>
      </div>
      <div class="gate-node-circle is-unassigned is-landing-preview" style="--c:${color}">
        <span class="gate-node-empty-label mono">${esc(this.formatTimerShortCode(timerId))}</span>
      </div>
      <span class="gate-node-start-btn is-placeholder-flag" aria-hidden="true">${icons.checkered(13)}</span>
    `;
    return slot;
  }

  /**
   * Returns true only when the pointer (x, y) is directly over the horizontal track line band.
   * Uses the live circle center inside `.gate-track-line` plus hysteresis so crossing the
   * threshold never oscillates even when circles scale down on narrower screens.
   */
  private isPointerDirectlyOnTrackLine(
    lineEl: HTMLElement,
    x: number,
    y: number,
    currentlyOver: boolean
  ): boolean {
    const boundsEl = lineEl.closest<HTMLElement>(".gate-track-scroll") ?? lineEl;
    const boundsRect = boundsEl.getBoundingClientRect();
    if (x < boundsRect.left - 12 || x > boundsRect.right + 12) return false;
    const firstCircle = lineEl.querySelector<HTMLElement>(".gate-node-circle");
    const lineCenterY = firstCircle
      ? firstCircle.getBoundingClientRect().top + firstCircle.getBoundingClientRect().height / 2
      : boundsRect.top + 54;
    const threshold = currentlyOver ? 64 : 48;
    return Math.abs(y - lineCenterY) <= threshold;
  }

  private autoScrollTrackAtEdge(scrollEl: HTMLElement | null, clientX: number): void {
    if (!scrollEl || scrollEl.scrollWidth <= scrollEl.clientWidth + 4) return;
    const sr = scrollEl.getBoundingClientRect();
    const edgeZone = 38;
    if (clientX < sr.left + edgeZone) {
      const intensity = Math.min(1, (sr.left + edgeZone - clientX) / edgeZone);
      scrollEl.scrollLeft -= Math.max(2, Math.round(intensity * 10));
    } else if (clientX > sr.right - edgeZone) {
      const intensity = Math.min(1, (clientX - (sr.right - edgeZone)) / edgeZone);
      scrollEl.scrollLeft += Math.max(2, Math.round(intensity * 10));
    }
  }

  private revealTrackNodeInScroll(assignedTimerId: number): void {
    const scrollEl = this.el.querySelector<HTMLElement>(".gate-track-scroll");
    const nodeEl = this.el.querySelector<HTMLElement>(
      `.gate-line-item[data-assigned-timer="${assignedTimerId}"]`
    );
    if (!scrollEl || !nodeEl) return;
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    if (maxScroll <= 4) return;
    const sr = scrollEl.getBoundingClientRect();
    const nr = nodeEl.getBoundingClientRect();
    const pad = 28;
    let targetLeft = scrollEl.scrollLeft;
    if (nr.left < sr.left + pad) {
      targetLeft += nr.left - (sr.left + pad);
    } else if (nr.right > sr.right - pad) {
      targetLeft += nr.right - (sr.right - pad);
    }
    targetLeft = Math.max(0, Math.min(maxScroll, targetLeft));
    if (Math.abs(targetLeft - scrollEl.scrollLeft) > 1) {
      scrollEl.scrollLeft = targetLeft;
      this.syncTrackScrollCues();
    }
  }

  /**
   * Dragging an unassigned timer from the tray onto the track line:
   *   - The landing placeholder slot ONLY appears when the dragged timer is directly over
   *     the track line itself.
   *   - When the track is empty, the existing dashed circle highlights in-place without
   *     inserting/removing DOM nodes or shifting any elements vertically.
   *   - Dropping over the track line fills the dashed circle in place without removing it
   *     first, avoiding any layout flash while the backend commits.
   */
  private beginTrayTimerDrag(downEvent: PointerEvent, tokenEl: HTMLElement): void {
    if (downEvent.pointerType === "touch") {
      downEvent.preventDefault();
    }
    try {
      tokenEl.setPointerCapture(downEvent.pointerId);
    } catch {
      // ignore if synthetic or unsupported
    }

    const timerId = Number(tokenEl.dataset.timerId);
    const color = timerColor(this.store, timerId);
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const tokenRect = tokenEl.getBoundingClientRect();
    const puckSize = tokenRect.width >= 24 ? Math.round(tokenRect.width) : 52;
    const halfPuck = puckSize / 2;
    const listEl = tokenEl.closest<HTMLElement>(".gate-unassigned-list");
    const initialScrollLeft = listEl?.scrollLeft ?? 0;
    const lineEl = this.el.querySelector<HTMLElement>("[data-track-line]");
    const emptyPlaceholder = this.el.querySelector<HTMLElement>("[data-empty-placeholder]");
    let started = false;
    let scrollingTray = false;
    let floatingEl: HTMLElement | null = null;
    let previewSlot: HTMLElement | null = null;
    let insertIndex: number | null = null;
    let isOverLine = false;

    const blockTouchScroll = (te: TouchEvent) => {
      if (te.cancelable) te.preventDefault();
    };
    window.addEventListener("touchmove", blockTouchScroll, { passive: false });

    const setEmptyPlaceholderPreview = (active: boolean) => {
      if (!emptyPlaceholder) return;
      const circle = emptyPlaceholder.querySelector<HTMLElement>(".gate-node-circle");
      const label = emptyPlaceholder.querySelector<HTMLElement>("[data-empty-circle-label]");
      if (active) {
        emptyPlaceholder.classList.add("is-insert-preview");
        emptyPlaceholder.style.setProperty("--c", color);
        if (circle) {
          circle.classList.add("is-landing-preview");
          circle.style.setProperty("--c", color);
        }
        if (label) label.textContent = this.formatTimerShortCode(timerId);
      } else {
        emptyPlaceholder.classList.remove("is-insert-preview");
        emptyPlaceholder.style.removeProperty("--c");
        if (circle) {
          circle.classList.remove("is-landing-preview");
          circle.style.removeProperty("--c");
        }
        if (label) label.textContent = "";
      }
    };

    const startDrag = (clientX: number, clientY: number) => {
      started = true;
      this.isDragging = true;
      document.body.classList.add("is-gate-dragging");
      tokenEl.classList.add("is-dragging-source");

      const ghost = document.createElement("div");
      ghost.className = "gate-node-circle is-filled gate-node-floating";
      ghost.style.setProperty("--c", color);
      ghost.style.width = `${puckSize}px`;
      ghost.style.height = `${puckSize}px`;
      ghost.style.transform = `translate3d(${clientX - halfPuck}px, ${clientY - halfPuck}px, 0) scale(1.06)`;
      ghost.innerHTML = `<span class="gate-node-timer-code mono">${esc(this.formatTimerShortCode(timerId))}</span>`;
      document.body.appendChild(ghost);
      floatingEl = ghost;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (scrollingTray && listEl) {
        listEl.scrollLeft = initialScrollLeft - dx;
        return;
      }
      if (!started) {
        if (Math.hypot(dx, dy) < 4) return;
        if (
          ev.pointerType === "touch" &&
          listEl &&
          listEl.scrollWidth > listEl.clientWidth + 2 &&
          Math.abs(dx) > Math.abs(dy) * 1.35
        ) {
          scrollingTray = true;
          listEl.scrollLeft = initialScrollLeft - dx;
          return;
        }
        startDrag(ev.clientX, ev.clientY);
      }
      if (!floatingEl || !lineEl) return;
      if (ev.cancelable) ev.preventDefault();
      floatingEl.style.transform = `translate3d(${ev.clientX - halfPuck}px, ${ev.clientY - halfPuck}px, 0) scale(1.06)`;

      const overTimeline = this.isPointerDirectlyOnTrackLine(
        lineEl,
        ev.clientX,
        ev.clientY,
        isOverLine
      );
      isOverLine = overTimeline;

      if (emptyPlaceholder) {
        setEmptyPlaceholderPreview(overTimeline);
        insertIndex = overTimeline ? 0 : null;
        return;
      }

      if (!overTimeline) {
        if (previewSlot) {
          previewSlot.remove();
          previewSlot = null;
          this.syncLinePositionsInPlace();
        }
        insertIndex = null;
        return;
      }

      if (!previewSlot) {
        previewSlot = this.createInsertionPreviewSlot(timerId, color);
      }

      const trackScrollEl = lineEl.closest<HTMLElement>(".gate-track-scroll");
      this.autoScrollTrackAtEdge(trackScrollEl, ev.clientX);

      const realNodes = [
        ...lineEl.querySelectorAll<HTMLElement>(".gate-line-item[data-gate]"),
      ];
      let targetIdx = realNodes.length;
      for (let i = 0; i < realNodes.length; i++) {
        const r = realNodes[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          targetIdx = i;
          break;
        }
      }

      insertIndex = targetIdx;
      const refNode = realNodes[targetIdx] ?? null;
      if (previewSlot.parentElement !== lineEl || previewSlot.nextElementSibling !== refNode) {
        lineEl.insertBefore(previewSlot, refNode);
        this.syncLinePositionsInPlace();
        this.scheduleSyncTrackScrollCues();
      }
    };

    const onEnd = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("touchmove", blockTouchScroll);
      try {
        if (tokenEl.hasPointerCapture(downEvent.pointerId)) {
          tokenEl.releasePointerCapture(downEvent.pointerId);
        }
      } catch {
        // ignore
      }
      document.body.classList.remove("is-gate-dragging");
      if (floatingEl) {
        floatingEl.remove();
        floatingEl = null;
      }

      const targetSlot = emptyPlaceholder ?? previewSlot;
      if (started && insertIndex !== null && targetSlot) {
        // Fill the dashed slot in-place immediately so the track line does not jump or flash
        // while the POST request completes.
        const previewCircle = targetSlot.querySelector<HTMLElement>(".gate-node-circle");
        if (previewCircle) {
          previewCircle.className = "gate-node-circle is-filled";
          previewCircle.style.setProperty("--c", color);
          previewCircle.innerHTML = `<span class="gate-node-timer-code mono">${esc(this.formatTimerShortCode(timerId))}</span>`;
        }
        targetSlot.classList.remove("is-drop-slot", "is-insert-preview", "is-empty-placeholder");
        tokenEl.style.display = "none";

        try {
          await this.api.addTrackNode("", timerId, insertIndex);
        } finally {
          this.isDragging = false;
          this.render(true);
          this.revealTrackNodeInScroll(timerId);
        }
      } else {
        tokenEl.classList.remove("is-dragging-source");
        if (emptyPlaceholder) {
          setEmptyPlaceholderPreview(false);
        }
        if (previewSlot) {
          previewSlot.remove();
          previewSlot = null;
        }
        this.isDragging = false;
        if (started) this.render(true);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  /**
   * Dragging a timer node on the track line:
   *   - Drag horizontally along the line: reorders the timer in the flying loop.
   *   - Drag down onto the Unassigned Timers box: keeps the dashed circle slot on the
   *     track line until the mouse is actually released, then removes the timer from the track.
   */
  private beginTrackNodeInteraction(downEvent: PointerEvent, item: HTMLElement): void {
    this.cancelTrackMomentum();
    try {
      item.setPointerCapture(downEvent.pointerId);
    } catch {
      // ignore if synthetic or unsupported
    }

    const nodeId = Number(item.dataset.gate);
    const circle = item.querySelector<HTMLElement>(".gate-node-circle") ?? item;
    const trayEl = this.el.querySelector<HTMLElement>("[data-unassigned-tray]");
    const scrollEl = item.closest<HTMLElement>(".gate-track-scroll");
    const canSideScroll = Boolean(scrollEl && scrollEl.scrollWidth > scrollEl.clientWidth + 4);
    const initialScrollLeft = scrollEl?.scrollLeft ?? 0;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const initialCircleRect = circle.getBoundingClientRect();
    let lastX = startX;
    let lastY = startY;
    let lastMoveTime = performance.now();
    let velocityX = 0;
    let started = false;
    let scrollingTrack = false;
    let floatingEl: HTMLElement | null = null;
    let overUnassignTray = false;
    let holdTimer = 0;

    const clearHoldTimer = () => {
      if (holdTimer) {
        window.clearTimeout(holdTimer);
        holdTimer = 0;
      }
    };

    const blockTouchScroll = (te: TouchEvent) => {
      if (te.cancelable) te.preventDefault();
    };
    window.addEventListener("touchmove", blockTouchScroll, { passive: false });

    const halfW = initialCircleRect.width / 2;
    const halfH = initialCircleRect.height / 2;

    const startDrag = (clientX: number, clientY: number) => {
      clearHoldTimer();
      started = true;
      this.isDragging = true;
      document.body.classList.add("is-gate-dragging");

      const clone = circle.cloneNode(true) as HTMLElement;
      clone.classList.add("gate-node-floating");
      clone.style.setProperty("--c", item.style.getPropertyValue("--c"));
      clone.style.width = `${initialCircleRect.width}px`;
      clone.style.height = `${initialCircleRect.height}px`;
      clone.style.transform = `translate3d(${clientX - halfW}px, ${clientY - halfH}px, 0) scale(1.06)`;
      document.body.appendChild(clone);
      floatingEl = clone;

      item.classList.add("is-drop-slot");
    };

    if (downEvent.pointerType === "touch" && canSideScroll) {
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        if (!started && !scrollingTrack) {
          startDrag(lastX, lastY);
        }
      }, 180);
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== downEvent.pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      lastX = ev.clientX;
      lastY = ev.clientY;

      if (scrollingTrack && scrollEl) {
        const now = performance.now();
        const dt = Math.max(1, now - lastMoveTime);
        const instVel = (ev.clientX - (scrollEl.dataset.lastPanX ? Number(scrollEl.dataset.lastPanX) : startX)) / dt;
        velocityX = velocityX * 0.35 + instVel * 0.65;
        scrollEl.dataset.lastPanX = String(ev.clientX);
        lastMoveTime = now;
        scrollEl.scrollLeft = initialScrollLeft - dx;
        return;
      }

      if (!started) {
        if (Math.hypot(dx, dy) < 5) return;
        clearHoldTimer();
        if (
          ev.pointerType === "touch" &&
          canSideScroll &&
          scrollEl &&
          Math.abs(dx) > Math.abs(dy) * 1.2
        ) {
          scrollingTrack = true;
          this.suppressNextTrackClick = true;
          scrollEl.dataset.lastPanX = String(ev.clientX);
          lastMoveTime = performance.now();
          scrollEl.scrollLeft = initialScrollLeft - dx;
          return;
        }
        startDrag(ev.clientX, ev.clientY);
      }
      if (!floatingEl) return;
      if (ev.cancelable) ev.preventDefault();
      floatingEl.style.transform = `translate3d(${ev.clientX - halfW}px, ${ev.clientY - halfH}px, 0) scale(1.06)`;

      // Check if dragging the timer over the Unassigned Timers tray.
      // Keep the dashed slot on the track line intact until the user releases the mouse!
      if (trayEl) {
        const tr = trayEl.getBoundingClientRect();
        const insideTray =
          ev.clientX >= tr.left &&
          ev.clientX <= tr.right &&
          ev.clientY >= tr.top - 8 &&
          ev.clientY <= tr.bottom + 8;
        if (overUnassignTray !== insideTray) {
          overUnassignTray = insideTray;
          trayEl.classList.toggle("is-drop-active", overUnassignTray);
        }
        if (overUnassignTray) return;
      }

      const parent = item.parentElement;
      if (!parent) return;

      // Only reorder along the track when the pointer is near the track line vertically.
      const lineCenterY = initialCircleRect.top + halfH;
      if (Math.abs(ev.clientY - lineCenterY) > 64) return;

      this.autoScrollTrackAtEdge(scrollEl, ev.clientX);

      const centerX = ev.clientX;
      const items = [...parent.querySelectorAll<HTMLElement>(".gate-line-item[data-gate]")];
      const currentIdx = items.indexOf(item);

      for (let i = 0; i < items.length; i++) {
        const other = items[i];
        if (other === item) continue;
        const r = other.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (currentIdx < i && centerX > mid) {
          parent.insertBefore(item, other.nextElementSibling);
          this.syncLinePositionsInPlace();
          break;
        }
        if (currentIdx > i && centerX < mid) {
          parent.insertBefore(item, other);
          this.syncLinePositionsInPlace();
          break;
        }
      }
    };

    const onEnd = () => {
      clearHoldTimer();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("touchmove", blockTouchScroll);
      try {
        if (item.hasPointerCapture(downEvent.pointerId)) {
          item.releasePointerCapture(downEvent.pointerId);
        }
      } catch {
        // ignore
      }
      document.body.classList.remove("is-gate-dragging");
      trayEl?.classList.remove("is-drop-active");
      if (floatingEl) {
        floatingEl.remove();
        floatingEl = null;
      }

      if (scrollingTrack && scrollEl) {
        delete scrollEl.dataset.lastPanX;
        if (performance.now() - lastMoveTime > 75) velocityX = 0;
        this.startTrackMomentum(scrollEl, velocityX);
        window.setTimeout(() => {
          this.suppressNextTrackClick = false;
        }, 50);
        this.isDragging = false;
        return;
      }

      if (started) {
        if (overUnassignTray) {
          void this.removeTrackNode(nodeId);
        } else {
          // Immediately fill the slot in its new position before saving to prevent any flash.
          item.classList.remove("is-drop-slot");
          void this.commitDragOrder(nodeId);
        }
      } else {
        this.isDragging = false;
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  private syncLinePositionsInPlace(): void {
    const items = [
      ...this.el.querySelectorAll<HTMLElement>(".gate-line-item"),
    ];
    const total = items.length;
    if (total === 0) return;

    const lastItem = items[total - 1];
    const lastColor = lastItem?.dataset.timerColor || "#64748b";

    items.forEach((item, idx) => {
      const orderEl = item.querySelector<HTMLElement>(".gate-node-order");
      if (orderEl) orderEl.textContent = `#${idx + 1}`;

      const c1 = item.dataset.timerColor || "#64748b";
      const nextItem = items[(idx + 1) % total];
      const c2 = nextItem?.dataset.timerColor || "#64748b";

      const leadPill = item.querySelector<HTMLElement>(".gate-line-sec-pill.is-leading");
      if (leadPill) {
        leadPill.style.setProperty("--c1", lastColor);
        leadPill.style.setProperty("--c2", c1);
        const leadCap = leadPill.querySelector<HTMLElement>(".sec-bicolor-capsule");
        if (leadCap) {
          leadCap.style.setProperty("--c1", lastColor);
          leadCap.style.setProperty("--c2", c1);
        }
        const leadText = leadPill.querySelector<HTMLElement>(".sec-pill-text") ?? leadPill;
        leadText.textContent = `S${total}`;
      }

      const trailPill = item.querySelector<HTMLElement>(".gate-line-sec-pill.is-trailing");
      if (trailPill) {
        trailPill.style.setProperty("--c1", c1);
        trailPill.style.setProperty("--c2", c2);
        const capsule = trailPill.querySelector<HTMLElement>(".sec-bicolor-capsule");
        if (capsule) {
          capsule.style.setProperty("--c1", c1);
          capsule.style.setProperty("--c2", c2);
        }
        const textEl = trailPill.querySelector<HTMLElement>(".sec-pill-text") ?? trailPill;
        textEl.textContent = `S${idx + 1}`;
      }
    });
  }

  private async commitDragOrder(dragId: number): Promise<void> {
    this.isDragging = true;
    try {
      const items = [...this.el.querySelectorAll<HTMLElement>(".gate-line-item[data-gate]")];
      const newIndex = items.findIndex((r) => Number(r.dataset.gate) === dragId);
      const oldIndex = this.orderedNodes.findIndex((n) => n.gateId === dragId);
      const node = this.store.node(dragId);
      if (node && newIndex >= 0 && newIndex !== oldIndex) {
        await this.save(node, { trackOrder: newIndex });
      }
    } finally {
      this.isDragging = false;
      this.render(true);
    }
  }

  private async save(
    node: TrackNode,
    change: Partial<Pick<TrackNode, "name" | "color" | "role" | "trackOrder" | "assignedTimerId">>
  ): Promise<void> {
    await this.api.updateTrackNode({
      gateId: node.gateId,
      name: change.name ?? node.name,
      color: change.color ?? node.color,
      role: change.role ?? node.role,
      trackOrder: change.trackOrder,
      assignedTimerId: change.assignedTimerId,
    });
  }
}
