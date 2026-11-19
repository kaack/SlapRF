/**
 * Wraps horizontally scrollable `.table-scroll` containers in a `.table-scroll-shell`
 * with full-height left/right edge scroll indicator buttons (`.table-edge-nav`),
 * and preserves horizontal & vertical scroll offsets across component re-renders.
 *
 * When a table overflows horizontally, the left/right sidebars appear
 * spanning the full height of the table so mobile users can tap either side
 * to scroll the table sideways without scrolling the whole section card.
 */

const SCROLLABLE_SELECTOR = ".table-scroll";
const EXTRA_SCROLL_PRESERVE_SELECTOR = ".gate-track-scroll";

interface ShellState {
  shell: HTMLElement;
  viewport: HTMLElement;
  leftBtn: HTMLButtonElement;
  rightBtn: HTMLButtonElement;
  update: () => void;
}

const managedTables = new WeakMap<HTMLElement, ShellState>();
const trackedExtraScrollables = new WeakSet<HTMLElement>();
const savedScrollByKey = new Map<string, { left: number; top: number }>();

function scrollKeyFor(el: HTMLElement): string | null {
  const host = el.closest<HTMLElement>("[data-slot], .card, .view, #app");
  if (!host) return null;
  const slotName = host.getAttribute("data-slot");
  const base = slotName
    ? `slot:${slotName}`
    : `cls:${host.className}|id:${host.id}`;
  return `${base}::${el.className.replace(/\btable-scroll-viewport\b/g, "").trim()}`;
}

function recordScrollOffset(el: HTMLElement): void {
  const key = scrollKeyFor(el);
  if (!key) return;
  savedScrollByKey.set(key, {
    left: el.scrollLeft,
    top: el.scrollTop,
  });
}

function restoreScrollOffset(el: HTMLElement): void {
  const key = scrollKeyFor(el);
  if (!key) return;
  const saved = savedScrollByKey.get(key);
  if (!saved) return;
  if (saved.left > 0 && el.scrollLeft !== saved.left) {
    el.scrollLeft = saved.left;
  }
  if (saved.top > 0 && el.scrollTop !== saved.top) {
    el.scrollTop = saved.top;
  }
}

function updateShell(state: ShellState): void {
  const { viewport, leftBtn, rightBtn, shell } = state;
  const maxScroll = viewport.scrollWidth - viewport.clientWidth;
  const canScrollLeft = viewport.scrollLeft > 4;
  const canScrollRight = maxScroll - viewport.scrollLeft > 4;

  shell.classList.toggle("has-overflow", maxScroll > 4);
  leftBtn.classList.toggle("is-visible", canScrollLeft);
  rightBtn.classList.toggle("is-visible", canScrollRight);
  fitScheduleLineups(viewport);
}

const trackedLineups = new WeakSet<HTMLElement>();

function updateSingleLineupMore(lineup: HTMLElement): void {
  const wrap = lineup.closest<HTMLElement>(".sched-lineup-wrap");
  if (!wrap) return;
  const leftCue = wrap.querySelector<HTMLButtonElement>(".sched-lineup-cue.is-left");
  const rightCue = wrap.querySelector<HTMLButtonElement>(".sched-lineup-cue.is-right");
  const maxScroll = Math.max(0, lineup.scrollWidth - lineup.clientWidth);
  const canLeft = maxScroll > 4 && lineup.scrollLeft > 4;
  const canRight = maxScroll > 4 && lineup.scrollLeft < maxScroll - 4;
  if (leftCue) leftCue.hidden = !canLeft;
  if (rightCue) rightCue.hidden = !canRight;
  wrap.classList.toggle("can-scroll-left", canLeft);
  wrap.classList.toggle("can-scroll-right", canRight);
}

function installLineupMomentumDrag(wrap: HTMLElement, lineup: HTMLElement): void {
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

  const cancelMomentum = (): void => {
    if (momentumRaf) {
      window.cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
    }
    lineup.classList.remove("is-dragging");
  };

  const startMomentum = (): void => {
    if (Math.abs(velocityX) < 0.12) return;
    let lastFrameTime = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(32, Math.max(1, now - lastFrameTime));
      lastFrameTime = now;
      const delta = velocityX * dt;
      const prev = lineup.scrollLeft;
      lineup.scrollLeft -= delta;
      velocityX *= Math.pow(0.95, dt / 16);
      if (Math.abs(velocityX) >= 0.05 && Math.abs(lineup.scrollLeft - prev) > 0.08) {
        momentumRaf = window.requestAnimationFrame(step);
      } else {
        momentumRaf = 0;
      }
    };
    momentumRaf = window.requestAnimationFrame(step);
  };

  let clearSuppressTimer = 0;

  wrap.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.pointerType === "touch") return;
    if ((e.target as HTMLElement | null)?.closest("[data-lineup-scroll]")) return;
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
    downScrollLeft = lineup.scrollLeft;
    draggedDuringPointer = false;
    suppressNextClick = false;
  });

  const onWindowPointerMove = (e: PointerEvent): void => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const dxTotal = e.clientX - downX;
    const dyTotal = e.clientY - downY;
    if (!draggedDuringPointer) {
      if (Math.abs(dxTotal) > 10 && Math.abs(dxTotal) >= Math.abs(dyTotal)) {
        draggedDuringPointer = true;
        suppressNextClick = true;
        lineup.classList.add("is-dragging");
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
      lineup.scrollLeft = downScrollLeft - dxTotal;
    }
  };

  const onWindowPointerUp = (e: PointerEvent): void => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    activePointerId = null;
    lineup.classList.remove("is-dragging");
    if (draggedDuringPointer) {
      if (performance.now() - lastMoveTime > 75) {
        velocityX = 0;
      }
      startMomentum();
      if (clearSuppressTimer) {
        window.clearTimeout(clearSuppressTimer);
      }
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

  wrap.addEventListener(
    "click",
    (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        "[data-lineup-scroll]"
      );
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        cancelMomentum();
        const dir = Number(btn.dataset.lineupScroll) < 0 ? -1 : 1;
        const step = Math.max(120, Math.round(lineup.clientWidth * 0.72));
        lineup.scrollBy({ left: dir * step, behavior: "smooth" });
        return;
      }
      if (suppressNextClick || draggedDuringPointer) {
        suppressNextClick = false;
        draggedDuringPointer = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

let sharedLineupRo: ResizeObserver | null = null;

function ensureLineupResizeObserver(): ResizeObserver {
  if (!sharedLineupRo) {
    sharedLineupRo = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target.classList.contains("sched-lineup")) {
          updateSingleLineupMore(target);
        }
      }
    });
  }
  return sharedLineupRo;
}

export function fitScheduleLineups(root: ParentNode = document): void {
  const lineups = root.querySelectorAll<HTMLElement>(".sched-lineup[data-fit-lineup]");
  const ro = ensureLineupResizeObserver();
  lineups.forEach((l) => {
    if (!trackedLineups.has(l)) {
      trackedLineups.add(l);
      let scrollRaf = 0;
      l.addEventListener(
        "scroll",
        () => {
          if (scrollRaf) return;
          scrollRaf = window.requestAnimationFrame(() => {
            scrollRaf = 0;
            updateSingleLineupMore(l);
          });
        },
        { passive: true }
      );
      ro.observe(l);
      const wrap = l.closest<HTMLElement>(".sched-lineup-wrap");
      if (wrap) {
        installLineupMomentumDrag(wrap, l);
      }
    }
    updateSingleLineupMore(l);
  });
}

function enhanceElement(el: HTMLElement, ro: ResizeObserver): void {
  if (managedTables.has(el)) {
    managedTables.get(el)!.update();
    return;
  }
  if (el.closest(".table-scroll-shell")) {
    return;
  }

  const parent = el.parentElement;
  if (!parent) return;

  const shell = document.createElement("div");
  shell.className = "table-scroll-shell";

  const viewport = el;
  parent.insertBefore(shell, el);
  shell.appendChild(el);
  viewport.classList.add("table-scroll-viewport");

  const leftBtn = document.createElement("button");
  leftBtn.type = "button";
  leftBtn.className = "table-edge-nav is-left";
  leftBtn.setAttribute("aria-label", "Scroll table left");
  leftBtn.title = "Scroll left";
  leftBtn.innerHTML = `<span class="table-edge-arrow"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

  const rightBtn = document.createElement("button");
  rightBtn.type = "button";
  rightBtn.className = "table-edge-nav is-right";
  rightBtn.setAttribute("aria-label", "Scroll table right");
  rightBtn.title = "Scroll right";
  rightBtn.innerHTML = `<span class="table-edge-arrow"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

  shell.appendChild(leftBtn);
  shell.appendChild(rightBtn);

  const state: ShellState = {
    shell,
    viewport,
    leftBtn,
    rightBtn,
    update: () => updateShell(state),
  };

  const scrollStep = (dir: -1 | 1) => {
    const step = Math.max(160, Math.round(viewport.clientWidth * 0.65));
    viewport.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  leftBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    scrollStep(-1);
  });

  rightBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    scrollStep(1);
  });

  // Suppress initial fade transition so newly enhanced tables don't flash their sidebars
  leftBtn.style.transition = "none";
  rightBtn.style.transition = "none";

  // Restore any prior horizontal/vertical scroll position before attaching listener
  restoreScrollOffset(viewport);

  viewport.addEventListener(
    "scroll",
    () => {
      recordScrollOffset(viewport);
      state.update();
    },
    { passive: true }
  );
  ro.observe(viewport);
  Array.from(viewport.children).forEach((child) => {
    if (child instanceof HTMLElement) {
      ro.observe(child);
    }
  });

  managedTables.set(el, state);
  state.update();
  requestAnimationFrame(() => {
    restoreScrollOffset(viewport);
    state.update();
    requestAnimationFrame(() => {
      leftBtn.style.transition = "";
      rightBtn.style.transition = "";
    });
  });
}

function preserveExtraScrollable(el: HTMLElement): void {
  if (trackedExtraScrollables.has(el)) return;
  trackedExtraScrollables.add(el);
  restoreScrollOffset(el);
  el.addEventListener(
    "scroll",
    () => {
      recordScrollOffset(el);
    },
    { passive: true }
  );
  requestAnimationFrame(() => {
    restoreScrollOffset(el);
  });
}

let installed = false;
let sharedTableRo: ResizeObserver | null = null;
let scanningTables = false;

function ensureTableResizeObserver(): ResizeObserver {
  if (!sharedTableRo) {
    sharedTableRo = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const shell = target.closest(".table-scroll-shell") as HTMLElement | null;
        if (!shell) continue;
        const vp = shell.querySelector<HTMLElement>(".table-scroll-viewport");
        const leftBtn = shell.querySelector<HTMLButtonElement>(".table-edge-nav.is-left");
        const rightBtn = shell.querySelector<HTMLButtonElement>(".table-edge-nav.is-right");
        if (vp && leftBtn && rightBtn) {
          updateShell({ shell, viewport: vp, leftBtn, rightBtn, update: () => {} });
        }
      }
    });
  }
  return sharedTableRo;
}

export function scanTableScrollIndicators(root: ParentNode = document): void {
  if (scanningTables) return;
  scanningTables = true;
  try {
    const ro = ensureTableResizeObserver();
    const matches = root.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTOR);
    matches.forEach((m) => enhanceElement(m, ro));
    const extras = root.querySelectorAll<HTMLElement>(EXTRA_SCROLL_PRESERVE_SELECTOR);
    extras.forEach((ex) => preserveExtraScrollable(ex));
    fitScheduleLineups(root);
  } finally {
    scanningTables = false;
  }
}

export function installTableScrollIndicators(): void {
  if (installed) return;
  installed = true;

  scanTableScrollIndicators(document);

  const mo = new MutationObserver((mutations) => {
    if (scanningTables) return;
    let shouldScan = false;
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (
          node instanceof HTMLElement &&
          !node.classList.contains("table-scroll-shell") &&
          !node.classList.contains("table-edge-nav")
        ) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) {
      scanTableScrollIndicators(document);
    }
  });

  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", () => scanTableScrollIndicators(document), { passive: true });
}
