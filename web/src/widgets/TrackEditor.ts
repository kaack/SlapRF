import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { DetectedTimer, TrackNode } from "../types/models";
import { renderSectionCapsuleIcon } from "./markup";

/**
 * Interactive course-line ("---O---O---O---O---") Track editor in System:
 *   - Dropping an unassigned timer onto the track line creates a gate at that position.
 *   - Dragging a timer along the track line reorders the course.
 *   - Dragging a timer off the track line into the Unassigned Timers box removes that gate
 *     when the mouse is released (keeping the dashed slot on the track until drop).
 *   - Below each gate on the track line sits a checkered flag icon button (active on the
 *     start gate, muted on split gates); clicking it directly sets that gate as the start gate.
 *   - Clicking any timer on the line selects it and shows its gate details below.
 */
export class TrackEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private selectedNodeId: number | null = null;
  private isDragging = false;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    this.listen(el, "keydown", (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.matches("[data-gate-name]")) return;
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        input.value = input.defaultValue;
        this.syncNodeNamePreview(Number(input.dataset.gateName), input.value);
        input.blur();
      }
    });

    this.listen(el, "input", (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.matches("[data-gate-name]")) return;
      this.syncNodeNamePreview(Number(input.dataset.gateName), input.value);
    });

    this.listen(el, "focusout", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.matches("[data-gate-name]")) void this.renameNode(input);
    });

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const makeStartBtn = target.closest<HTMLElement>("[data-make-start]");
      if (makeStartBtn) {
        e.stopPropagation();
        void this.makeStart(Number(makeStartBtn.dataset.makeStart));
      }
    });

    this.listen(el, "pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;

      // Clicking the checkered flag button beneath a node should not start a node drag.
      if (target.closest("[data-make-start]")) return;

      const trayTimerEl = target.closest<HTMLElement>(".unassigned-puck-token[data-puck-id]");
      if (trayTimerEl) {
        this.beginTrayTimerDrag(e, trayTimerEl);
        return;
      }

      const interactiveNodePart = target.closest<HTMLElement>(
        ".gate-node-circle, .gate-node-name, .gate-node-top"
      );
      const nodeEl = interactiveNodePart?.closest<HTMLElement>(".gate-line-item[data-gate]");
      if (nodeEl) {
        this.beginTrackNodeInteraction(e, nodeEl);
      }
    });

    this.onDispose(
      store.subscribe(["config", "status"], () => {
        const active = document.activeElement;
        const editing =
          (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
          this.el.contains(active);
        if (!editing && !this.isDragging) this.render();
      })
    );
    this.render();
  }

  private get orderedNodes(): TrackNode[] {
    return [...this.store.pucks].sort((a, b) => a.trackOrder - b.trackOrder);
  }

  private get detectedTimers(): DetectedTimer[] {
    if (this.store.detectedPucks.length > 0) {
      return [...this.store.detectedPucks].sort((a, b) => a.puckId - b.puckId);
    }
    return this.store.pucks
      .filter((p) => (p.assignedPuckId ?? p.puckId) > 0)
      .map((p) => ({
        puckId: p.assignedPuckId ?? p.puckId,
        puckLabel: p.puckLabel ?? "",
        color: p.color,
        isHub: (p.assignedPuckId ?? p.puckId) === 1,
        batteryMv: p.batteryMv,
        batteryPct: p.batteryPct,
        noiseFloorDbm: p.noiseFloorDbm,
        online: p.online,
        lastSeenAt: p.lastSeenAt,
      }))
      .sort((a, b) => a.puckId - b.puckId);
  }

  private formatTimerShortCode(timerId: number): string {
    return timerId > 0 ? `T${timerId}` : "—";
  }

  private ensureSelectedNode(nodes: TrackNode[]): TrackNode | null {
    if (nodes.length === 0) {
      this.selectedNodeId = null;
      return null;
    }
    const found = nodes.find((n) => n.puckId === this.selectedNodeId);
    if (found) return found;
    this.selectedNodeId = nodes[0].puckId;
    return nodes[0];
  }

  private render(): void {
    const nodes = this.orderedNodes;
    const detected = this.detectedTimers;
    const selectedNode = this.ensureSelectedNode(nodes);
    const selectedIndex = selectedNode
      ? nodes.findIndex((n) => n.puckId === selectedNode.puckId)
      : -1;
    const assignedTimerIds = new Set(
      nodes.map((n) => n.assignedPuckId ?? 0).filter((id) => id > 0)
    );
    const unassignedTimers = detected.filter((d) => !assignedTimerIds.has(d.puckId));

    this.el.innerHTML = `
      <div class="gate-track-stage">
        <div class="gate-track-header">
          <span class="gate-track-caption">
            Drag timers onto the line to add gates · drag along the line to reorder · drag into Unassigned timers to remove
          </span>
        </div>

        <div class="gate-track-scroll" data-track-dropzone>
          <div class="gate-track-line ${nodes.length === 0 ? "is-empty-line" : ""}" data-track-line role="list" aria-label="Course gate order">
            ${
              nodes.length === 0
                ? this.renderEmptyTimelinePlaceholder()
                : nodes
                    .map((n, idx) =>
                      this.renderTrackNode(
                        n,
                        idx,
                        nodes,
                        detected,
                        selectedNode !== null && n.puckId === selectedNode.puckId
                      )
                    )
                    .join("")
            }
          </div>
        </div>

        ${this.renderUnassignedTray(unassignedTimers)}
      </div>

      ${selectedNode ? this.renderInspector(selectedNode, selectedIndex, detected) : ""}
    `;
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
          <span class="gate-node-empty-label" data-empty-circle-label>Drop<br/>timer</span>
        </div>
        <div class="gate-node-name is-empty-slot-caption" data-empty-slot-name>Drag a timer onto the line to create Gate #1</div>
        <span class="gate-node-start-btn is-placeholder-flag" aria-hidden="true">${icons.checkered(13)}</span>
      </div>`;
  }

  private renderTrackNode(
    node: TrackNode,
    index: number,
    allNodes: TrackNode[],
    detected: DetectedTimer[],
    isSelected: boolean
  ): string {
    const total = allNodes.length;
    const isStart = node.role === "START_FINISH";
    const assignedId = node.assignedPuckId ?? 0;
    const hasTimer = assignedId > 0;
    const tiedTimer = detected.find((d) => d.puckId === assignedId);
    const shortCode = this.formatTimerShortCode(assignedId);
    const roleSub = hasTimer ? (tiedTimer?.isHub || assignedId === 1 ? "HUB" : "SPK") : "EMPTY";
    const color = hasTimer ? timerColor(this.store, assignedId) : "#64748b";

    const lastNode = allNodes[(total - 1 + total) % total];
    const lastAssignedId = lastNode?.assignedPuckId ?? 0;
    const lastColor = lastAssignedId > 0 ? timerColor(this.store, lastAssignedId) : "#64748b";

    const nextNode = allNodes[(index + 1) % total];
    const nextAssignedId = nextNode?.assignedPuckId ?? 0;
    const nextColor = nextAssignedId > 0 ? timerColor(this.store, nextAssignedId) : "#64748b";

    const displayName = node.name.trim() || `Gate ${index + 1}`;
    const isOnline = tiedTimer ? tiedTimer.online : node.online;
    const sectionTag = `S${index + 1}`;
    const wrapSectionTag = `S${total}`;

    return `
      <div
        class="gate-line-item ${isSelected ? "is-selected" : ""} ${isStart ? "is-start" : ""} ${hasTimer ? "has-puck" : "is-empty-gate"}"
        data-gate="${node.puckId}"
        data-assigned-puck="${assignedId}"
        data-puck-color="${color}"
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
          class="gate-node-circle ${hasTimer ? "is-filled" : "is-unassigned"}"
          aria-pressed="${isSelected}"
          aria-label="Gate ${index + 1}: ${esc(displayName)} (${hasTimer ? shortCode : "Unassigned"})"
          title="Click to inspect · Drag left/right to reorder · Drag down to Unassigned timers to remove gate"
        >
          ${
            hasTimer
              ? `
                <span class="gate-node-puck-code mono">${esc(shortCode)}</span>
                <span class="gate-node-puck-meta">
                  <span class="gate-node-status-dot ${isOnline ? "is-online" : ""}"></span>
                  <span>${roleSub}</span>
                </span>`
              : `
                <span class="gate-node-empty-label">Empty</span>`
          }
        </button>

        <div class="gate-node-name" data-node-name="${node.puckId}">${esc(displayName)}</div>

        <button
          type="button"
          class="gate-node-start-btn ${isStart ? "is-active" : ""}"
          data-make-start="${node.puckId}"
          aria-pressed="${isStart}"
          title="${isStart ? "Start gate" : "Set as start gate"}"
          aria-label="${isStart ? `Gate ${index + 1} is the start gate` : `Set Gate ${index + 1} as start gate`}"
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
                ? "Drag a timer onto the track line above to create a gate at that spot"
                : "All timers are on the track · drag a timer off the line into this box to remove its gate"
            }
          </span>
        </div>
        <div class="gate-unassigned-list">
          ${
            unassigned.length > 0
              ? unassigned.map((d) => this.renderTrayTimer(d)).join("")
              : `<span class="gate-unassigned-empty-chip">Drop a timer here to remove its gate from the track</span>`
          }
        </div>
      </div>`;
  }

  private renderTrayTimer(d: DetectedTimer): string {
    const color = timerColor(this.store, d.puckId);
    const roleSub = d.isHub ? "HUB" : "SPK";
    const label = d.puckLabel?.trim() ? ` · ${d.puckLabel.trim()}` : "";
    return `
      <div
        class="unassigned-puck-token"
        data-puck-id="${d.puckId}"
        style="--c:${color}"
        title="P${d.puckId}${esc(label)} (${roleSub}) · Drag onto the track line above to create a gate"
      >
        <span class="unassigned-puck-dot" style="--c:${color}">
          <span class="mono">P${d.puckId}</span>
        </span>
        <div class="unassigned-puck-info">
          <span class="unassigned-puck-name mono">P${d.puckId}${esc(label)}</span>
          <span class="unassigned-puck-sub">
            <span class="gate-node-status-dot ${d.online ? "is-online" : ""}"></span>
            ${d.isHub ? "Hub" : "Spoke"} · ${d.online ? `${d.batteryPct}%` : "Offline"}
          </span>
        </div>
      </div>`;
  }

  private renderInspector(
    node: TrackNode,
    index: number,
    detected: DetectedTimer[]
  ): string {
    const isStart = node.role === "START_FINISH";
    const assignedId = node.assignedPuckId ?? 0;
    const hasTimer = assignedId > 0;
    const tiedTimer = detected.find((d) => d.puckId === assignedId);
    const defaultPlaceholder = `Gate ${index + 1}`;
    const color = hasTimer ? timerColor(this.store, assignedId) : "#64748b";

    const timerSummaryHtml = hasTimer
      ? `
        <div class="gate-inspector-puck-box">
          <span class="gate-inspector-dot" style="--c:${color}"></span>
          <strong class="mono">T${assignedId}${tiedTimer?.puckLabel?.trim() ? ` · ${esc(tiedTimer.puckLabel.trim())}` : ""}</strong>
          <span class="detected-role-pill ${tiedTimer?.isHub || assignedId === 1 ? "is-hub" : ""}">
            ${tiedTimer?.isHub || assignedId === 1 ? "Hub" : "Spoke"}
          </span>
          <span class="muted mono">${tiedTimer ? (tiedTimer.online ? `${tiedTimer.batteryPct}%` : "Offline") : ""}</span>
        </div>`
      : `
        <div class="gate-inspector-puck-box is-empty">
          <span class="muted">No timer assigned</span>
        </div>`;

    return `
      <div class="gate-inspector" style="--c:${color}">
        <div class="gate-inspector-head">
          <div class="gate-inspector-title">
            <span class="gate-inspector-step mono">#${index + 1}</span>
            ${hasTimer ? `<span class="gate-inspector-dot" style="--c:${color}"></span>` : ""}
            <strong>${esc(node.name.trim() || `Gate ${index + 1}`)}</strong>
            ${
              isStart
                ? `<span class="badge badge-accent gate-inspector-start-badge">${icons.checkered(12)} Start gate</span>`
                : `<span class="badge">Split gate</span>`
            }
          </div>
        </div>

        <div class="gate-inspector-grid is-two-col">
          <label class="field">
            <span class="field-label">Gate name</span>
            <input
              class="input gate-name-field"
              data-gate-name="${node.puckId}"
              value="${esc(node.name)}"
              placeholder="${esc(defaultPlaceholder)}"
              maxlength="40"
              spellcheck="false"
              autocomplete="off"
            />
          </label>

          <div class="field">
            <span class="field-label">Timer at this gate</span>
            ${timerSummaryHtml}
          </div>
        </div>
      </div>`;
  }

  private syncNodeNamePreview(nodeId: number, rawName: string): void {
    const idx = this.orderedNodes.findIndex((n) => n.puckId === nodeId);
    const display = rawName.trim() || `Gate ${idx >= 0 ? idx + 1 : nodeId}`;
    const nodeLabel = this.el.querySelector<HTMLElement>(`[data-node-name="${nodeId}"]`);
    if (nodeLabel) nodeLabel.textContent = display;
    const titleStrong = this.el.querySelector<HTMLElement>(".gate-inspector-title strong");
    if (titleStrong && this.selectedNodeId === nodeId) titleStrong.textContent = display;
  }

  private async removeTrackNode(nodeId: number): Promise<void> {
    this.isDragging = true;
    try {
      await this.api.removeTrackNode(nodeId);
      if (this.selectedNodeId === nodeId) {
        this.selectedNodeId = this.orderedNodes[0]?.puckId ?? null;
      }
    } finally {
      this.isDragging = false;
      this.render();
    }
  }

  private async renameNode(input: HTMLInputElement): Promise<void> {
    const node = this.store.puck(Number(input.dataset.gateName));
    if (!node) return;
    const name = input.value.trim();
    if (name === node.name.trim()) return;
    input.defaultValue = name;
    await this.save(node, { name });
  }

  private async makeStart(nodeId: number): Promise<void> {
    const node = this.store.puck(nodeId);
    if (!node || node.role === "START_FINISH") return;
    await this.save(node, { role: "START_FINISH" });
  }

  private createInsertionPreviewSlot(timerId: number, color: string): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "gate-line-item is-drop-slot is-insert-preview";
    slot.dataset.puckColor = color;
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
        <span class="gate-node-empty-label mono">T${timerId}</span>
      </div>
      <div class="gate-node-name">New gate</div>
      <span class="gate-node-start-btn is-placeholder-flag" aria-hidden="true">${icons.checkered(13)}</span>
    `;
    return slot;
  }

  /**
   * Returns true only when the pointer (x, y) is directly over the horizontal track line band.
   * Uses the fixed 58px vertical center of the track line inside `.gate-track-line` plus
   * hysteresis so crossing the threshold never oscillates.
   */
  private isPointerDirectlyOnTrackLine(
    lineEl: HTMLElement,
    x: number,
    y: number,
    currentlyOver: boolean
  ): boolean {
    const lineRect = lineEl.getBoundingClientRect();
    if (x < lineRect.left || x > lineRect.right) return false;
    const lineCenterY = lineRect.top + 58;
    const threshold = currentlyOver ? 44 : 32;
    return Math.abs(y - lineCenterY) <= threshold;
  }

  /**
   * Dragging an unassigned timer from the tray onto the track line:
   *   - The landing placeholder slot ONLY appears when the dragged timer is directly over
   *     the track line itself (within ±32px of the line's center).
   *   - When the track is empty, the existing dashed circle highlights in-place without
   *     inserting/removing DOM nodes or shifting any elements vertically.
   *   - Dropping over the track line fills the dashed circle in place without removing it
   *     first, avoiding any layout flash while the backend commits.
   */
  private beginTrayTimerDrag(downEvent: PointerEvent, tokenEl: HTMLElement): void {
    const timerId = Number(tokenEl.dataset.puckId);
    const color = timerColor(this.store, timerId);
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const lineEl = this.el.querySelector<HTMLElement>("[data-track-line]");
    const emptyPlaceholder = this.el.querySelector<HTMLElement>("[data-empty-placeholder]");
    let started = false;
    let floatingEl: HTMLElement | null = null;
    let previewSlot: HTMLElement | null = null;
    let insertIndex: number | null = null;
    let isOverLine = false;

    const setEmptyPlaceholderPreview = (active: boolean) => {
      if (!emptyPlaceholder) return;
      const circle = emptyPlaceholder.querySelector<HTMLElement>(".gate-node-circle");
      const label = emptyPlaceholder.querySelector<HTMLElement>("[data-empty-circle-label]");
      const nameEl = emptyPlaceholder.querySelector<HTMLElement>("[data-empty-slot-name]");
      if (active) {
        emptyPlaceholder.classList.add("is-insert-preview");
        emptyPlaceholder.style.setProperty("--c", color);
        if (circle) {
          circle.classList.add("is-landing-preview");
          circle.style.setProperty("--c", color);
        }
        if (label) label.textContent = `T${timerId}`;
        if (nameEl) nameEl.textContent = "New gate";
      } else {
        emptyPlaceholder.classList.remove("is-insert-preview");
        emptyPlaceholder.style.removeProperty("--c");
        if (circle) {
          circle.classList.remove("is-landing-preview");
          circle.style.removeProperty("--c");
        }
        if (label) label.innerHTML = "Drop<br/>timer";
        if (nameEl) nameEl.textContent = "Drag a timer onto the line to create Gate #1";
      }
    };

    const startDrag = () => {
      started = true;
      this.isDragging = true;
      document.body.classList.add("is-gate-dragging");
      tokenEl.classList.add("is-dragging-source");

      const ghost = document.createElement("div");
      ghost.className = "gate-node-circle is-filled gate-node-floating";
      ghost.style.setProperty("--c", color);
      ghost.style.width = "58px";
      ghost.style.height = "58px";
      ghost.style.left = `${startX - 29}px`;
      ghost.style.top = `${startY - 29}px`;
      ghost.innerHTML = `<span class="gate-node-puck-code mono">T${timerId}</span>`;
      document.body.appendChild(ghost);
      floatingEl = ghost;
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < 4) return;
        startDrag();
      }
      if (!floatingEl || !lineEl) return;
      ev.preventDefault();
      floatingEl.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.06)`;

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
      }
    };

    const onEnd = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
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
          previewCircle.innerHTML = `<span class="gate-node-puck-code mono">T${timerId}</span>`;
        }
        targetSlot.classList.remove("is-drop-slot", "is-insert-preview", "is-empty-placeholder");
        tokenEl.style.display = "none";

        try {
          const beforeIds = new Set(this.store.pucks.map((p) => p.puckId));
          await this.api.addTrackNode("", timerId, insertIndex);
          const created = this.store.pucks.find((p) => !beforeIds.has(p.puckId));
          if (created) {
            this.selectedNodeId = created.puckId;
          }
        } finally {
          this.isDragging = false;
          this.render();
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
        if (started) this.render();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  /**
   * Clicking or dragging a node on the track line:
   *   - Click: selects the node in the inspector below.
   *   - Drag horizontally along the line: reorders the node in the flying loop.
   *   - Drag down onto the Unassigned Timers box: keeps the dashed circle slot on the
   *     track line until the mouse is actually released, then removes the node.
   */
  private beginTrackNodeInteraction(downEvent: PointerEvent, item: HTMLElement): void {
    const nodeId = Number(item.dataset.gate);
    const circle = item.querySelector<HTMLElement>(".gate-node-circle") ?? item;
    const trayEl = this.el.querySelector<HTMLElement>("[data-unassigned-tray]");
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const initialCircleRect = circle.getBoundingClientRect();
    let started = false;
    let floatingEl: HTMLElement | null = null;
    let overUnassignTray = false;

    const startDrag = () => {
      started = true;
      this.isDragging = true;
      this.selectedNodeId = nodeId;
      document.body.classList.add("is-gate-dragging");

      const clone = circle.cloneNode(true) as HTMLElement;
      clone.classList.add("gate-node-floating");
      clone.style.setProperty("--c", item.style.getPropertyValue("--c"));
      clone.style.left = `${initialCircleRect.left}px`;
      clone.style.top = `${initialCircleRect.top}px`;
      clone.style.width = `${initialCircleRect.width}px`;
      clone.style.height = `${initialCircleRect.height}px`;
      document.body.appendChild(clone);
      floatingEl = clone;

      item.classList.add("is-drop-slot");
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < 5) return;
        startDrag();
      }
      if (!floatingEl) return;
      ev.preventDefault();
      floatingEl.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.06)`;

      // Check if dragging the timer over the Unassigned Timers tray.
      // Keep the dashed slot on the track line intact until the user releases the mouse!
      if (trayEl) {
        const tr = trayEl.getBoundingClientRect();
        const insideTray =
          ev.clientX >= tr.left &&
          ev.clientX <= tr.right &&
          ev.clientY >= tr.top &&
          ev.clientY <= tr.bottom;
        if (overUnassignTray !== insideTray) {
          overUnassignTray = insideTray;
          trayEl.classList.toggle("is-drop-active", overUnassignTray);
        }
        if (overUnassignTray) return;
      }

      const parent = item.parentElement;
      if (!parent) return;

      // Only reorder along the track when the pointer is near the track line vertically.
      const lineCenterY = initialCircleRect.top + initialCircleRect.height / 2;
      if (Math.abs(ev.clientY - lineCenterY) > 48) return;

      const centerX = initialCircleRect.left + initialCircleRect.width / 2 + dx;
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
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.classList.remove("is-gate-dragging");
      trayEl?.classList.remove("is-drop-active");
      if (floatingEl) {
        floatingEl.remove();
        floatingEl = null;
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
        if (this.selectedNodeId !== nodeId) {
          this.selectedNodeId = nodeId;
          this.render();
        }
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
    const lastColor = lastItem?.dataset.puckColor || "#64748b";

    items.forEach((item, idx) => {
      const orderEl = item.querySelector<HTMLElement>(".gate-node-order");
      if (orderEl) orderEl.textContent = `#${idx + 1}`;

      const c1 = item.dataset.puckColor || "#64748b";
      const nextItem = items[(idx + 1) % total];
      const c2 = nextItem?.dataset.puckColor || "#64748b";

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
      const oldIndex = this.orderedNodes.findIndex((n) => n.puckId === dragId);
      const node = this.store.puck(dragId);
      if (node && newIndex >= 0 && newIndex !== oldIndex) {
        await this.save(node, { trackOrder: newIndex });
      }
    } finally {
      this.isDragging = false;
      this.render();
    }
  }

  private async save(
    node: TrackNode,
    change: Partial<Pick<TrackNode, "name" | "color" | "role" | "trackOrder" | "assignedPuckId">>
  ): Promise<void> {
    await this.api.updateTrackNode({
      puckId: node.puckId,
      name: change.name ?? node.name,
      color: change.color ?? node.color,
      role: change.role ?? node.role,
      trackOrder: change.trackOrder,
      assignedPuckId: change.assignedPuckId,
    });
  }
}
