/**
 * Wraps horizontally scrollable tables/grids in a `.table-scroll-shell`
 * with full-height left/right edge scroll indicator buttons (`.table-edge-nav`).
 *
 * When a table overflows horizontally, the left/right sidebars appear
 * spanning the full height of the table so mobile users can tap either side
 * to scroll the table sideways without scrolling the whole section card.
 */

const SCROLLABLE_SELECTORS = [
  ".table-scroll",
  ".cmp-table",
  ".slot-table",
  ".puck-table",
  ".table-standings",
].join(", ");

interface ShellState {
  shell: HTMLElement;
  viewport: HTMLElement;
  leftBtn: HTMLButtonElement;
  rightBtn: HTMLButtonElement;
  update: () => void;
}

const managedTables = new WeakMap<HTMLElement, ShellState>();

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

  const isScrollContainer = el.classList.contains("table-scroll");
  const parent = el.parentElement;
  if (!parent) return;

  const shell = document.createElement("div");
  shell.className = "table-scroll-shell";

  let viewport: HTMLElement;
  if (isScrollContainer) {
    viewport = el;
    parent.insertBefore(shell, el);
    shell.appendChild(el);
    viewport.classList.add("table-scroll-viewport");
  } else {
    viewport = document.createElement("div");
    viewport.className = "table-scroll-viewport";
    parent.insertBefore(shell, el);
    viewport.appendChild(el);
    shell.appendChild(viewport);
  }

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

  viewport.addEventListener("scroll", state.update, { passive: true });
  ro.observe(viewport);
  if (viewport !== el) {
    ro.observe(el);
  }

  managedTables.set(el, state);
  requestAnimationFrame(state.update);
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

  const scan = (root: ParentNode = document) => {
    const matches = root.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTORS);
    matches.forEach((m) => enhanceElement(m, ro));
  };

  scan(document);

  const mo = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      scan(document);
    }
  });

  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", () => scan(document), { passive: true });
}
