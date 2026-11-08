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
  leftBtn.innerHTML = `<span class="table-edge-arrow">‹</span>`;

  const rightBtn = document.createElement("button");
  rightBtn.type = "button";
  rightBtn.className = "table-edge-nav is-right";
  rightBtn.setAttribute("aria-label", "Scroll table right");
  rightBtn.title = "Scroll right";
  rightBtn.innerHTML = `<span class="table-edge-arrow">›</span>`;

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
  const innerTable = viewport.firstElementChild;
  if (innerTable instanceof HTMLElement) {
    ro.observe(innerTable);
  }

  managedTables.set(el, state);
  state.update();
  requestAnimationFrame(() => {
    restoreScrollOffset(viewport);
    state.update();
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

export function installTableScrollIndicators(): void {
  if (installed) return;
  installed = true;

  const ro = new ResizeObserver((entries) => {
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

  let scanning = false;
  const scan = (root: ParentNode = document) => {
    if (scanning) return;
    scanning = true;
    try {
      const matches = root.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTOR);
      matches.forEach((m) => enhanceElement(m, ro));
      const extras = root.querySelectorAll<HTMLElement>(EXTRA_SCROLL_PRESERVE_SELECTOR);
      extras.forEach((ex) => preserveExtraScrollable(ex));
    } finally {
      scanning = false;
    }
  };

  scan(document);

  const mo = new MutationObserver((mutations) => {
    if (scanning) return;
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
      scan(document);
    }
  });

  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", () => scan(document), { passive: true });
}
