import { icons } from "./icons";

const CUE_WIDTH_PX = 20;

export interface LapsInnerScrollOptions {
  /** Total width in px of sticky left columns (e.g. 62 on mobile, 170 or 306 on desktop). */
  fixedLeftPx: number;
  /** Total width in px of sticky right columns (e.g. 146 on mobile, 174 on desktop). */
  fixedRightPx: number;
  /** Number of rendered section columns in the middle area. */
  sectorCount: number;
  /**
   * Fixed maximum visible sections (e.g. 3 for mobile sectors table), or "auto"
   * to fit as many `minSectorWidthPx` columns as fit (at least 3).
   */
  maxVisibleSectors: number | "auto";
  /** Minimum width in px per sector column (e.g. 48 on mobile, 92 on desktop). */
  minSectorWidthPx: number;
  /** Optional callback fired whenever horizontal scrollLeft changes. */
  onScrollLeftChange?: (scrollLeft: number) => void;
  /** Optional horizontal scroll position to restore on initial bind. */
  initialScrollLeft?: number;
}

interface ManagedShellState {
  shell: HTMLElement;
  viewport: HTMLElement;
  table: HTMLElement;
  leftCue: HTMLButtonElement | null;
  rightCue: HTMLButtonElement | null;
  opts: LapsInnerScrollOptions;
  sectorColW: number;
  recalc: () => void;
  syncCues: () => void;
  cancelAnim: () => void;
}

const managedShells = new WeakMap<HTMLElement, ManagedShellState>();
const viewportToShell = new WeakMap<HTMLElement, HTMLElement>();
let sharedResizeObserver: ResizeObserver | null = null;

function ensureResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const vp = entry.target as HTMLElement;
        const shell = viewportToShell.get(vp);
        if (!shell) continue;
        if (!shell.isConnected) {
          sharedResizeObserver?.unobserve(vp);
          continue;
        }
        managedShells.get(shell)?.recalc();
      }
    });
  }
  return sharedResizeObserver;
}

export function renderLapsInnerScrollShell(
  tableHtml: string,
  fixedLeftPx: number,
  fixedRightPx: number,
  extraViewportClass = ""
): string {
  const vpCls = extraViewportClass
    ? `laps-inner-scroll-viewport ${extraViewportClass}`
    : "laps-inner-scroll-viewport";
  return `<div class="laps-inner-scroll-shell" style="--laps-fixed-left:${fixedLeftPx}px;--laps-fixed-right:${fixedRightPx}px">
    <div class="${vpCls}">${tableHtml}</div>
    <button type="button" class="laps-sec-cue is-left" data-laps-sec-scroll="-1" aria-label="Scroll sections left" title="Scroll sections left" hidden><span class="laps-sec-cue-pill">${icons.chevronLeft(13)}</span></button>
    <button type="button" class="laps-sec-cue is-right" data-laps-sec-scroll="1" aria-label="Scroll sections right" title="Scroll sections right" hidden><span class="laps-sec-cue-pill">${icons.chevronRight(13)}</span></button>
  </div>`;
}

export function bindLapsInnerScroll(shell: HTMLElement, opts: LapsInnerScrollOptions): void {
  shell.style.setProperty("--laps-fixed-left", `${opts.fixedLeftPx}px`);
  shell.style.setProperty("--laps-fixed-right", `${opts.fixedRightPx}px`);

  const existing = managedShells.get(shell);
  if (existing) {
    existing.opts = opts;
    existing.recalc();
    return;
  }

  const viewport = shell.querySelector<HTMLElement>(".laps-inner-scroll-viewport");
  const table = viewport?.querySelector<HTMLElement>("table") ?? null;
  if (!viewport || !table) return;

  const leftCue = shell.querySelector<HTMLButtonElement>(".laps-sec-cue.is-left");
  const rightCue = shell.querySelector<HTMLButtonElement>(".laps-sec-cue.is-right");

  let animRaf = 0;
  let initialRestored = false;

  const cancelAnim = (): void => {
    if (animRaf) {
      window.cancelAnimationFrame(animRaf);
      animRaf = 0;
    }
  };

  const animateScrollTo = (targetLeft: number): void => {
    cancelAnim();
    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const clamped = Math.max(0, Math.min(maxScroll, targetLeft));
    const startLeft = viewport.scrollLeft;
    const delta = clamped - startLeft;
    if (Math.abs(delta) < 1) {
      viewport.scrollLeft = clamped;
      state.syncCues();
      return;
    }
    const startTime = performance.now();
    const durationMs = 150;
    // Advance immediately on the click turn so instant DOM inspections see movement right away.
    viewport.scrollLeft = startLeft + delta * 0.25;
    state.syncCues();
    const tick = (now: number): void => {
      const t = Math.min(1, Math.max(0, (now - startTime) / durationMs));
      const eased = 1 - Math.pow(1 - t, 3);
      viewport.scrollLeft = startLeft + delta * eased;
      state.syncCues();
      if (t < 1) {
        animRaf = window.requestAnimationFrame(tick);
      } else {
        animRaf = 0;
        viewport.scrollLeft = clamped;
        state.syncCues();
      }
    };
    animRaf = window.requestAnimationFrame(tick);
  };

  const state: ManagedShellState = {
    shell,
    viewport,
    table,
    leftCue,
    rightCue,
    opts,
    sectorColW: opts.minSectorWidthPx,
    cancelAnim,
    syncCues: () => {
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const hasOverflow = shell.classList.contains("has-sector-overflow") && maxScroll > 2;
      const canLeft = hasOverflow && viewport.scrollLeft > 2;
      const canRight = hasOverflow && viewport.scrollLeft < maxScroll - 2;
      if (leftCue) leftCue.hidden = !canLeft;
      if (rightCue) rightCue.hidden = !canRight;
      shell.classList.toggle("can-scroll-left", canLeft);
      shell.classList.toggle("can-scroll-right", canRight);
    },
    recalc: () => {
      const curOpts = state.opts;
      shell.style.setProperty("--laps-fixed-left", `${curOpts.fixedLeftPx}px`);
      shell.style.setProperty("--laps-fixed-right", `${curOpts.fixedRightPx}px`);

      const fallbackW = curOpts.fixedLeftPx < 100 ? 360 : 880;
      const measuredW = viewport.clientWidth || shell.clientWidth || fallbackW;
      const middleW = Math.max(
        curOpts.minSectorWidthPx * 3,
        measuredW - curOpts.fixedLeftPx - curOpts.fixedRightPx
      );

      const visibleCap =
        curOpts.maxVisibleSectors === "auto"
          ? Math.max(3, Math.floor((middleW - CUE_WIDTH_PX) / curOpts.minSectorWidthPx))
          : curOpts.maxVisibleSectors;

      const canOverflow = curOpts.sectorCount > visibleCap;
      if (!canOverflow) {
        shell.classList.remove("has-sector-overflow", "can-scroll-left", "can-scroll-right");
        table.classList.remove("is-scrollable-sectors");
        table.style.removeProperty("--sector-col-w");
        table.style.removeProperty("width");
        table.style.removeProperty("min-width");
        if (leftCue) leftCue.hidden = true;
        if (rightCue) rightCue.hidden = true;
        if (viewport.scrollLeft !== 0) {
          viewport.scrollLeft = 0;
        }
        return;
      }

      const sectorColW = Math.max(
        curOpts.minSectorWidthPx,
        (middleW - CUE_WIDTH_PX) / visibleCap
      );
      state.sectorColW = sectorColW;
      const totalTableW =
        curOpts.fixedLeftPx + curOpts.sectorCount * sectorColW + curOpts.fixedRightPx;

      shell.classList.add("has-sector-overflow");
      table.classList.add("is-scrollable-sectors");
      table.style.setProperty("--sector-col-w", `${sectorColW.toFixed(2)}px`);
      table.style.width = `${totalTableW.toFixed(2)}px`;
      table.style.minWidth = `${totalTableW.toFixed(2)}px`;

      if (!initialRestored) {
        initialRestored = true;
        if ((curOpts.initialScrollLeft ?? 0) > 0) {
          viewport.scrollLeft = curOpts.initialScrollLeft!;
        }
      }
      state.syncCues();
    },
  };

  let scrollRaf = 0;
  viewport.addEventListener(
    "scroll",
    () => {
      state.opts.onScrollLeftChange?.(viewport.scrollLeft);
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = 0;
        state.syncCues();
      });
    },
    { passive: true }
  );

  // Mouse drag-to-scroll with momentum and post-drag click suppression so dragging a row never scratches a lap.
  let activePointerId: number | null = null;
  let downX = 0;
  let downY = 0;
  let downScrollLeft = 0;
  let lastX = 0;
  let lastMoveTime = 0;
  let velocityX = 0;
  let dragged = false;
  let suppressNextClick = false;
  let clearSuppressTimer = 0;

  const startDragMomentum = (): void => {
    if (Math.abs(velocityX) < 0.12) return;
    let lastFrameTime = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(32, Math.max(1, now - lastFrameTime));
      lastFrameTime = now;
      const prev = viewport.scrollLeft;
      viewport.scrollLeft -= velocityX * dt;
      velocityX *= Math.pow(0.94, dt / 16);
      state.syncCues();
      if (Math.abs(velocityX) >= 0.05 && Math.abs(viewport.scrollLeft - prev) > 0.08) {
        animRaf = window.requestAnimationFrame(step);
      } else {
        animRaf = 0;
      }
    };
    animRaf = window.requestAnimationFrame(step);
  };

  const onWindowPointerMove = (e: PointerEvent): void => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (!dragged) {
      if (Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy)) {
        dragged = true;
        suppressNextClick = true;
        shell.classList.add("is-dragging");
      }
    }
    if (dragged) {
      const now = performance.now();
      const dt = Math.max(1, now - lastMoveTime);
      const instVel = (e.clientX - lastX) / dt;
      velocityX = velocityX * 0.35 + instVel * 0.65;
      lastX = e.clientX;
      lastMoveTime = now;
      viewport.scrollLeft = downScrollLeft - dx;
      state.syncCues();
    }
  };

  const detachWindowPointerListeners = (): void => {
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerUp);
  };

  const onWindowPointerUp = (e: PointerEvent): void => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    activePointerId = null;
    detachWindowPointerListeners();
    shell.classList.remove("is-dragging");
    if (dragged) {
      if (performance.now() - lastMoveTime > 75) {
        velocityX = 0;
      }
      startDragMomentum();
      if (clearSuppressTimer) window.clearTimeout(clearSuppressTimer);
      clearSuppressTimer = window.setTimeout(() => {
        suppressNextClick = false;
        dragged = false;
        clearSuppressTimer = 0;
      }, 60);
    } else {
      suppressNextClick = false;
      dragged = false;
    }
  };

  shell.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      cancelAnim();
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!shell.classList.contains("has-sector-overflow")) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-laps-sec-scroll], .lap-delete-btn")) return;

    if (clearSuppressTimer) {
      window.clearTimeout(clearSuppressTimer);
      clearSuppressTimer = 0;
    }
    cancelAnim();
    activePointerId = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
    lastX = e.clientX;
    lastMoveTime = performance.now();
    velocityX = 0;
    downScrollLeft = viewport.scrollLeft;
    dragged = false;
    suppressNextClick = false;
    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
    window.addEventListener("pointerup", onWindowPointerUp, { passive: true });
    window.addEventListener("pointercancel", onWindowPointerUp, { passive: true });
  });

  shell.addEventListener(
    "click",
    (e: MouseEvent) => {
      const cueBtn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        "[data-laps-sec-scroll]"
      );
      if (cueBtn) {
        e.preventDefault();
        e.stopPropagation();
        const dir = Number(cueBtn.dataset.lapsSecScroll) < 0 ? -1 : 1;
        const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const step = Math.max(48, state.sectorColW);
        let nextLeft = viewport.scrollLeft + dir * step;
        if (dir > 0 && maxScroll - viewport.scrollLeft <= step * 1.35) {
          nextLeft = maxScroll;
        } else if (dir < 0 && viewport.scrollLeft <= step * 1.35) {
          nextLeft = 0;
        }
        animateScrollTo(nextLeft);
        return;
      }
      if (suppressNextClick || dragged) {
        suppressNextClick = false;
        dragged = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  managedShells.set(shell, state);
  viewportToShell.set(viewport, shell);
  ensureResizeObserver()?.observe(viewport);

  state.recalc();
  window.requestAnimationFrame(() => {
    if (shell.isConnected) {
      state.recalc();
    }
  });
}

export function refreshLapsInnerScroll(root: ParentNode): void {
  const shells = root.querySelectorAll<HTMLElement>(".laps-inner-scroll-shell");
  shells.forEach((shell) => {
    managedShells.get(shell)?.recalc();
  });
}
