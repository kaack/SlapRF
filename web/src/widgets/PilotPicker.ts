import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { practiceStats } from "../state/analysis";
import { AppStore } from "../state/store";

const IDLE_REFRESH_MS = 5000;

export interface PilotPickerOptions {
  /** Currently selected slot; null means the "All" chip. */
  value: () => number | null;
  onSelect: (slotIndex: number | null) => void;
  /** Show an "All" chip before the pilots. */
  includeAll?: boolean;
}

/** Row of pilot chips. Used by the live view (with "All") and pilot analysis. */
export class PilotPicker extends Component {
  private readonly store: AppStore;
  private readonly opts: PilotPickerOptions;
  private readonly trackEl: HTMLElement;
  private readonly leftCueBtn: HTMLButtonElement;
  private readonly rightCueBtn: HTMLButtonElement;
  private renderedStructureSig = "";

  constructor(el: HTMLElement, store: AppStore, opts?: Partial<PilotPickerOptions>) {
    super(el);
    this.store = store;
    this.opts = {
      value: opts?.value ?? (() => store.selectedPilot),
      onSelect: opts?.onSelect ?? ((slot) => slot !== null && store.selectPilot(slot)),
      includeAll: opts?.includeAll ?? false,
    };
    el.classList.add("pilot-picker-shell");
    el.innerHTML = `
      <button type="button" class="pilot-picker-cue is-left" data-pilot-scroll="-1" aria-label="Scroll pilots left" title="More pilots left" hidden>${icons.chevronLeft(14)}</button>
      <div class="pilot-picker" role="tablist" aria-label="Pilot" data-pilot-track></div>
      <button type="button" class="pilot-picker-cue is-right" data-pilot-scroll="1" aria-label="Scroll pilots right" title="More pilots right" hidden>${icons.chevronRight(14)}</button>`;

    this.trackEl = el.querySelector<HTMLElement>("[data-pilot-track]")!;
    this.leftCueBtn = el.querySelector<HTMLButtonElement>('[data-pilot-scroll="-1"]')!;
    this.rightCueBtn = el.querySelector<HTMLButtonElement>('[data-pilot-scroll="1"]')!;

    let activePointerId: number | null = null;
    let downX = 0;
    let downY = 0;
    let downScrollLeft = 0;
    let lastX = 0;
    let lastMoveTime = 0;
    let velocityX = 0;
    let draggedDuringPointer = false;
    let suppressNextClick = false;
    let momentumRaf = 0;

    const cancelMomentum = () => {
      if (momentumRaf) {
        window.cancelAnimationFrame(momentumRaf);
        momentumRaf = 0;
      }
      this.trackEl.classList.remove("is-dragging");
    };

    const startMomentum = () => {
      if (Math.abs(velocityX) < 0.12) return;
      let lastFrameTime = performance.now();
      const step = (now: number) => {
        const dt = Math.min(32, Math.max(1, now - lastFrameTime));
        lastFrameTime = now;
        const delta = velocityX * dt;
        const prev = this.trackEl.scrollLeft;
        this.trackEl.scrollLeft -= delta;
        // Smooth inertial decay (~0.95 per 16ms frame)
        velocityX *= Math.pow(0.95, dt / 16);
        if (Math.abs(velocityX) >= 0.05 && Math.abs(this.trackEl.scrollLeft - prev) > 0.08) {
          momentumRaf = window.requestAnimationFrame(step);
        } else {
          momentumRaf = 0;
        }
      };
      momentumRaf = window.requestAnimationFrame(step);
    };

    let clearSuppressTimer = 0;

    this.listen(el, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if ((e.target as HTMLElement).closest("[data-pilot-scroll]")) return;
      if (clearSuppressTimer) {
        window.clearTimeout(clearSuppressTimer);
        clearSuppressTimer = 0;
      }
      cancelMomentum();
      activePointerId = e.pointerId;
      downX = e.clientX;
      downY = e.clientY;
      lastX = e.clientX;
      lastMoveTime = performance.now();
      velocityX = 0;
      downScrollLeft = this.trackEl.scrollLeft;
      draggedDuringPointer = false;
      suppressNextClick = false;
    });

    const onWindowPointerMove = (e: PointerEvent) => {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      const dxTotal = e.clientX - downX;
      const dyTotal = e.clientY - downY;
      if (!draggedDuringPointer) {
        if (Math.abs(dxTotal) > 6 && Math.abs(dxTotal) >= Math.abs(dyTotal)) {
          draggedDuringPointer = true;
          suppressNextClick = true;
          this.trackEl.classList.add("is-dragging");
        }
      }
      if (draggedDuringPointer) {
        const now = performance.now();
        const dt = Math.max(1, now - lastMoveTime);
        const stepDx = e.clientX - lastX;
        const instVel = stepDx / dt;
        velocityX = velocityX * 0.35 + instVel * 0.65;
        lastX = e.clientX;
        lastMoveTime = now;
        this.trackEl.scrollLeft = downScrollLeft - dxTotal;
      }
    };

    const onWindowPointerUp = (e: PointerEvent) => {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      activePointerId = null;
      this.trackEl.classList.remove("is-dragging");
      if (draggedDuringPointer) {
        if (performance.now() - lastMoveTime > 75) {
          velocityX = 0;
        }
        startMomentum();
        if (clearSuppressTimer) window.clearTimeout(clearSuppressTimer);
        clearSuppressTimer = window.setTimeout(() => {
          suppressNextClick = false;
          draggedDuringPointer = false;
          clearSuppressTimer = 0;
        }, 50);
      } else {
        suppressNextClick = false;
        draggedDuringPointer = false;
      }
    };

    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
    window.addEventListener("pointerup", onWindowPointerUp, { passive: true });
    window.addEventListener("pointercancel", onWindowPointerUp, { passive: true });
    this.onDispose(() => {
      cancelMomentum();
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerUp);
    });

    const handleSelect = (e: Event) => {
      const scrollBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-pilot-scroll]");
      if (scrollBtn) {
        e.preventDefault();
        e.stopPropagation();
        cancelMomentum();
        const dir = Number(scrollBtn.dataset.pilotScroll) || 1;
        this.trackEl.scrollBy({
          left: dir * Math.max(140, Math.round(this.trackEl.clientWidth * 0.68)),
          behavior: "smooth",
        });
        return;
      }
      if (suppressNextClick || draggedDuringPointer) {
        suppressNextClick = false;
        draggedDuringPointer = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-pilot]");
      if (!chip) return;
      const v = chip.dataset.pilot;
      this.opts.onSelect(v === "all" ? null : Number(v));
      const maxScroll = this.trackEl.scrollWidth - this.trackEl.clientWidth;
      if (maxScroll > 0) {
        const trackRect = this.trackEl.getBoundingClientRect();
        const chipRect = chip.getBoundingClientRect();
        const pad = 28;
        let targetLeft = this.trackEl.scrollLeft;
        if (chipRect.left < trackRect.left + pad) {
          targetLeft += chipRect.left - (trackRect.left + pad);
        } else if (chipRect.right > trackRect.right - pad) {
          targetLeft += chipRect.right - (trackRect.right - pad);
        }
        targetLeft = Math.max(0, Math.min(maxScroll, targetLeft));
        try {
          this.trackEl.scrollTo({ left: targetLeft, behavior: "smooth" });
        } catch {
          this.trackEl.scrollLeft = targetLeft;
        }
      }
    };
    this.listen(el, "click", handleSelect);
    this.listen(this.trackEl, "scroll", () => this.syncScrollCues());
    const onResize = () => this.syncScrollCues();
    window.addEventListener("resize", onResize);
    this.onDispose(() => window.removeEventListener("resize", onResize));
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.syncScrollCues());
      ro.observe(this.trackEl);
      this.onDispose(() => ro.disconnect());
    }
    this.onDispose(store.subscribe(["config", "selection", "laps", "crossings", "practice"], () => this.render()));
    const timer = window.setInterval(() => this.render(), IDLE_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.render();
  }

  private syncScrollCues(): void {
    const maxScroll = Math.max(0, this.trackEl.scrollWidth - this.trackEl.clientWidth);
    const canLeft = maxScroll > 4 && this.trackEl.scrollLeft > 4;
    const canRight = maxScroll > 4 && this.trackEl.scrollLeft < maxScroll - 4;
    this.leftCueBtn.hidden = !canLeft;
    this.rightCueBtn.hidden = !canRight;
    this.el.classList.toggle("can-scroll-left", canLeft);
    this.el.classList.toggle("can-scroll-right", canRight);
  }

  private render(): void {
    const selected = this.opts.value();
    const enabled = this.store.enabledPilots;
    const structureSig = `${this.opts.includeAll ? "all|" : ""}${enabled.map((p) => p.slotIndex).join(",")}`;

    if (structureSig !== this.renderedStructureSig) {
      this.renderedStructureSig = structureSig;
      const all = this.opts.includeAll
        ? `<button class="pilot-chip pilot-chip-all ${selected === null ? "is-active" : ""}" role="tab"
             aria-selected="${selected === null}" data-pilot="all">
             <span class="pilot-chip-name">All</span>
           </button>`
        : "";
      const pilots = enabled
        .map((p) => {
          const active = p.slotIndex === selected;
          const s = practiceStats(this.store, p);
          const laps = s.laps.length;
          return `
            <button class="pilot-chip ${active ? "is-active" : ""} ${s.onTrack ? "is-live" : ""}" role="tab" aria-selected="${active}" data-pilot="${p.slotIndex}" data-analytics-pilot-pill="${p.slotIndex}" style="--c:${p.color}">
              <span class="dot ${s.onTrack ? "is-live" : ""}"></span>
              <span class="pilot-chip-name">${esc(p.callsign)}</span>
              <span class="pilot-chip-time">${laps} laps</span>
            </button>`;
        })
        .join("");
      this.trackEl.innerHTML = all + pilots;
      requestAnimationFrame(() => this.syncScrollCues());
      return;
    }

    const allBtn = this.trackEl.querySelector<HTMLButtonElement>('button[data-pilot="all"]');
    if (allBtn) {
      const isAll = selected === null;
      allBtn.classList.toggle("is-active", isAll);
      allBtn.setAttribute("aria-selected", String(isAll));
    }

    for (const p of enabled) {
      const btn = this.trackEl.querySelector<HTMLButtonElement>(`button[data-pilot="${p.slotIndex}"]`);
      if (!btn) continue;
      const active = p.slotIndex === selected;
      const s = practiceStats(this.store, p);
      const laps = s.laps.length;
      btn.classList.toggle("is-active", active);
      btn.classList.toggle("is-live", s.onTrack);
      btn.setAttribute("aria-selected", String(active));
      btn.style.setProperty("--c", p.color);
      const dot = btn.querySelector<HTMLElement>(".dot");
      if (dot) dot.classList.toggle("is-live", s.onTrack);
      const nameEl = btn.querySelector<HTMLElement>(".pilot-chip-name");
      if (nameEl && nameEl.textContent !== p.callsign) nameEl.textContent = p.callsign;
      const timeEl = btn.querySelector<HTMLElement>(".pilot-chip-time");
      const timeText = `${laps} laps`;
      if (timeEl && timeEl.textContent !== timeText) timeEl.textContent = timeText;
    }
    this.syncScrollCues();
  }
}
