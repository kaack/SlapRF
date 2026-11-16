import { esc } from "../core/format";
import { icons } from "../core/icons";

export interface WireDropOption {
  id: string;
  label: string;
  iconHtml: string;
  disabled?: boolean;
  title?: string;
}

export interface OpenWireDropMenuParams {
  viewport: HTMLElement;
  svg?: SVGSVGElement | null;
  outPort?: HTMLElement | null;
  clientX: number;
  clientY: number;
  tetherPathD?: string;
  isBottomPort?: boolean;
  ariaLabel?: string;
  ignoreDismissClickMs?: number;
  options: WireDropOption[];
  onSelect: (id: string) => void;
}

let activeDismissFn: (() => void) | null = null;

/** Dismisses any open wire-drop contextual `+` menu and removes its tether wire. */
export function dismissWireDropMenu(): void {
  if (activeDismissFn) {
    const fn = activeDismissFn;
    activeDismissFn = null;
    fn();
  }
}

/** Briefly highlights a newly spawned stage or round card on canvas. */
export function flashSpawnedCanvasNode(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove("rc-just-added");
  void el.offsetWidth;
  el.classList.add("rc-just-added");
  window.setTimeout(() => {
    el.classList.remove("rc-just-added");
  }, 1400);
}

/**
 * Opens an already-expanded `+` contextual speed-dial menu right where an output wire was dropped
 * in empty canvas space, keeping a tether curve attached from the source port until resolved.
 */
export function openWireDropMenu(params: OpenWireDropMenuParams): void {
  const {
    viewport,
    svg,
    outPort,
    clientX,
    clientY,
    tetherPathD,
    isBottomPort,
    ariaLabel,
    ignoreDismissClickMs = 0,
    options,
    onSelect,
  } = params;
  if (options.length === 0) return;

  dismissWireDropMenu();
  const openedAt = performance.now();

  let tetherPath: SVGPathElement | null = null;
  if (svg && tetherPathD) {
    tetherPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tetherPath.setAttribute(
      "class",
      `bkt-wire is-drag-preview is-context-tether${isBottomPort ? " is-bottom" : ""}`
    );
    tetherPath.setAttribute("d", tetherPathD);
    svg.appendChild(tetherPath);
  }
  outPort?.classList.add("is-active");

  const vpRect = viewport.getBoundingClientRect();
  const vx = Math.max(24, Math.min(Math.max(24, vpRect.width - 24), clientX - vpRect.left));
  const vy = Math.max(24, Math.min(Math.max(24, vpRect.height - 24), clientY - vpRect.top));

  const flipLeft = vx > vpRect.width - 255;
  const estListH = options.length * 44 + 8;
  const flipUp = vy + estListH * 0.6 > vpRect.height - 16 && vy > estListH * 0.6 + 16;

  const menuEl = document.createElement("div");
  menuEl.className = `rc-wire-drop-menu${flipLeft ? " is-flip-left" : ""}${flipUp ? " is-flip-up" : ""}`;
  menuEl.setAttribute("data-wire-drop-menu", "");
  menuEl.setAttribute("data-rc-hud", "");
  menuEl.style.left = `${Math.round(vx)}px`;
  menuEl.style.top = `${Math.round(vy)}px`;

  const itemsHtml = options
    .map(
      (opt, idx) => `
      <button
        type="button"
        class="rc-wire-drop-item${opt.disabled ? " is-disabled" : ""}"
        role="menuitem"
        data-wire-drop-opt="${esc(opt.id)}"
        style="--item-idx:${idx}"
        ${opt.disabled ? "disabled" : ""}
        ${opt.title ? `title="${esc(opt.title)}"` : ""}
      >
        <span class="rc-wire-drop-icon">${opt.iconHtml}</span>
        <span class="rc-wire-drop-label">${esc(opt.label)}</span>
      </button>`
    )
    .join("");

  menuEl.innerHTML = `
    <button
      type="button"
      class="rc-wire-drop-anchor"
      data-wire-drop-dismiss
      title="Cancel"
      aria-label="Close contextual add menu"
    >
      <span class="rc-wire-drop-plus">${icons.plus(18)}</span>
    </button>
    <div class="rc-wire-drop-list" role="menu" aria-label="${esc(ariaLabel || "Add to board")}">
      ${itemsHtml}
    </div>
  `;

  viewport.appendChild(menuEl);

  const onOutsidePointerDown = (ev: PointerEvent): void => {
    const t = ev.target as Node | null;
    if (t && menuEl.contains(t)) return;
    dismissWireDropMenu();
  };

  const onWheel = (): void => {
    dismissWireDropMenu();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      dismissWireDropMenu();
    }
  };

  const onHashChange = (): void => {
    dismissWireDropMenu();
  };

  menuEl.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
  });

  menuEl.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });

  menuEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    if (t.closest("[data-wire-drop-dismiss]")) {
      if (ignoreDismissClickMs > 0 && performance.now() - openedAt < ignoreDismissClickMs) {
        return;
      }
      dismissWireDropMenu();
      return;
    }
    const optBtn = t.closest<HTMLButtonElement>("[data-wire-drop-opt]");
    if (optBtn && !optBtn.disabled) {
      const chosenId = optBtn.dataset.wireDropOpt ?? "";
      dismissWireDropMenu();
      if (chosenId) onSelect(chosenId);
    }
  });

  activeDismissFn = () => {
    window.removeEventListener("pointerdown", onOutsidePointerDown, true);
    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("hashchange", onHashChange);
    outPort?.classList.remove("is-active");
    if (tetherPath?.parentNode) {
      tetherPath.parentNode.removeChild(tetherPath);
    }
    if (menuEl.parentNode) {
      menuEl.parentNode.removeChild(menuEl);
    }
  };

  window.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("hashchange", onHashChange);
}
