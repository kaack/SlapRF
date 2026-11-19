import { esc } from "../core/format";
import { icons } from "../core/icons";

export interface CanvasSelectOption {
  value: string;
  label: string;
  group?: string;
  dotColor?: string;
  separatorBefore?: boolean;
  disabled?: boolean;
}

export interface RenderCanvasSelectParams {
  value: string;
  label: string;
  options: CanvasSelectOption[];
  className?: string;
  title?: string;
  ariaLabel?: string;
  mono?: boolean;
  isSeed?: boolean;
  dotColor?: string;
  disabled?: boolean;
  dataAttrs?: string;
}

export interface CanvasSelectChangeDetail {
  value: string;
}

let boundGlobal = false;
let activeTrigger: HTMLElement | null = null;
let activeTriggerKey = "";
let activePopover: HTMLElement | null = null;
let activeOptions: CanvasSelectOption[] = [];
let activeSelectedValue = "";
let closedOnPointerDownKey = "";
let closedOnPointerDownAt = 0;

function computeCanvasTriggerKey(trigger: HTMLElement): string {
  const parts: string[] = [];
  if (trigger.id) parts.push(`id:${trigger.id}`);
  const aria = trigger.getAttribute("aria-label");
  if (aria) parts.push(`aria:${aria}`);
  const dsKeys = Object.keys(trigger.dataset)
    .filter((k) => k !== "cselectOptions" && k !== "cselectValue" && k !== "cselectTrigger")
    .sort();
  for (const k of dsKeys) {
    parts.push(`d:${k}=${trigger.dataset[k] ?? ""}`);
  }
  return parts.join("|");
}

function findMatchingLiveCanvasTrigger(key: string): HTMLElement | null {
  if (!key || typeof document === "undefined") return null;
  const all = document.querySelectorAll<HTMLElement>("[data-cselect-trigger]");
  for (const el of Array.from(all)) {
    if (el.isConnected && computeCanvasTriggerKey(el) === key) {
      return el;
    }
  }
  return null;
}

export function renderCanvasSelect(params: RenderCanvasSelectParams): string {
  const cls = [
    "rc-cselect-trigger",
    params.className ?? "",
    params.mono ? "mono" : "",
    params.isSeed ? "is-seed-select" : "",
    params.disabled ? "is-disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const titleAttr = params.title ? `title="${esc(params.title)}"` : "";
  const ariaAttr = `aria-label="${esc(params.ariaLabel || params.title || params.label)}"`;
  const disabledAttr = params.disabled ? "disabled" : "";
  const dotHtml = params.dotColor
    ? params.dotColor === "hollow"
      ? `<span class="dot is-hollow"></span>`
      : `<span class="dot" style="--c:${esc(params.dotColor)}"></span>`
    : "";

  return `<button type="button" class="${cls}" data-cselect-trigger data-cselect-value="${esc(params.value)}" data-cselect-options="${esc(JSON.stringify(params.options))}" ${params.dataAttrs ?? ""} ${titleAttr} ${ariaAttr} ${disabledAttr} aria-haspopup="listbox" aria-expanded="false">${dotHtml}<span class="rc-cselect-label">${esc(params.label)}</span><span class="rc-cselect-caret">${icons.chevronDown(11)}</span></button>`;
}

export function closeCanvasSelectPopover(): void {
  if (activeTrigger) {
    activeTrigger.classList.remove("is-open");
    activeTrigger.setAttribute("aria-expanded", "false");
    activeTrigger = null;
  }
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  activeTriggerKey = "";
  activeOptions = [];
  activeSelectedValue = "";
}

function renderOptionsListHtml(options: CanvasSelectOption[], selectedVal: string, query: string): string {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          (o.group && o.group.toLowerCase().includes(q))
      )
    : options;

  if (filtered.length === 0) {
    return `<div class="rc-cselect-empty note">No matches for “${esc(query.trim())}”.</div>`;
  }

  let html = "";
  let lastGroup = "";
  for (const opt of filtered) {
    const grp = opt.group ?? "";
    if (opt.separatorBefore && html !== "") {
      html += `<div class="rc-cselect-sep"></div>`;
    }
    if (grp && grp !== lastGroup) {
      if (html !== "" && !opt.separatorBefore) {
        html += `<div class="rc-cselect-sep"></div>`;
      }
      html += `<div class="rc-cselect-group">${esc(grp)}</div>`;
      lastGroup = grp;
    } else if (!grp && lastGroup) {
      html += `<div class="rc-cselect-sep"></div>`;
      lastGroup = "";
    }

    const isSelected = selectedVal !== "" && opt.value === selectedVal;
    const isDisabled = !!opt.disabled;
    const dotHtml = opt.dotColor
      ? opt.dotColor === "hollow"
        ? `<span class="dot is-hollow"></span>`
        : `<span class="dot" style="--c:${esc(opt.dotColor)}"></span>`
      : "";
    const checkHtml = isSelected
      ? `<span class="rc-cselect-check">${icons.check(12)}</span>`
      : `<span class="rc-cselect-check-spacer"></span>`;

    html += `<button type="button" role="option" aria-selected="${isSelected ? "true" : "false"}" ${isDisabled ? 'aria-disabled="true" disabled' : ""} class="rc-cselect-item ${isSelected ? "is-active" : ""} ${isDisabled ? "is-disabled" : ""}" data-cselect-option="${esc(opt.value)}"><span class="rc-cselect-item-main">${dotHtml}<span class="rc-cselect-item-text">${esc(opt.label)}</span></span>${checkHtml}</button>`;
  }
  return html;
}

function positionPopover(trigger: HTMLElement, pop: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minW = Math.max(Math.round(r.width), 124);
  pop.style.minWidth = `${minW}px`;

  // Measure natural dimensions
  const pr = pop.getBoundingClientRect();
  const pw = Math.max(pr.width, minW);
  const ph = pr.height || 220;

  let left = Math.round(r.left);
  if (left + pw > vw - 10) {
    left = Math.max(10, Math.round(r.right - pw));
  }
  left = Math.max(10, Math.min(left, vw - pw - 10));

  let top = Math.round(r.bottom + 5);
  if (top + ph > vh - 10 && r.top - ph - 5 >= 10) {
    top = Math.round(r.top - ph - 5);
  } else if (top + ph > vh - 10) {
    top = Math.max(10, vh - ph - 10);
  }

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openForTrigger(trigger: HTMLElement): void {
  if ((trigger as HTMLButtonElement).disabled || trigger.classList.contains("is-disabled")) {
    return;
  }
  const incomingKey = computeCanvasTriggerKey(trigger);
  if (
    activePopover &&
    (activeTrigger === trigger || (incomingKey !== "" && activeTriggerKey === incomingKey))
  ) {
    closeCanvasSelectPopover();
    return;
  }
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (
    closedOnPointerDownAt > 0 &&
    now - closedOnPointerDownAt < 350 &&
    incomingKey !== "" &&
    closedOnPointerDownKey === incomingKey
  ) {
    closedOnPointerDownKey = "";
    closedOnPointerDownAt = 0;
    return;
  }
  closedOnPointerDownKey = "";
  closedOnPointerDownAt = 0;
  closeCanvasSelectPopover();

  let parsed: CanvasSelectOption[] = [];
  try {
    parsed = JSON.parse(trigger.dataset.cselectOptions || "[]") as CanvasSelectOption[];
  } catch {
    parsed = [];
  }
  if (parsed.length === 0) return;

  activeTrigger = trigger;
  activeTriggerKey = incomingKey;
  activeOptions = parsed;
  activeSelectedValue = trigger.dataset.cselectValue ?? "";

  trigger.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");

  const showSearch = parsed.length > 10;
  const pop = document.createElement("div");
  pop.className = `rc-cselect-popover ${trigger.classList.contains("mono") ? "is-mono" : ""}`;
  pop.setAttribute("data-cselect-popover", "");
  pop.setAttribute("role", "listbox");

  pop.innerHTML = `
    ${
      showSearch
        ? `<div class="rc-cselect-search-wrap">
            ${icons.search(13)}
            <input type="search" class="rc-cselect-search" data-cselect-search placeholder="Filter…" autocomplete="off" />
          </div>`
        : ""
    }
    <div class="rc-cselect-list" data-cselect-list>
      ${renderOptionsListHtml(parsed, activeSelectedValue, "")}
    </div>`;

  document.body.appendChild(pop);
  activePopover = pop;
  positionPopover(trigger, pop);

  const searchInput = pop.querySelector<HTMLInputElement>("[data-cselect-search]");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const listEl = pop.querySelector<HTMLElement>("[data-cselect-list]");
      if (listEl) {
        listEl.innerHTML = renderOptionsListHtml(activeOptions, activeSelectedValue, searchInput.value);
        positionPopover(activeTrigger && activeTrigger.isConnected ? activeTrigger : trigger, pop);
      }
    });
    requestAnimationFrame(() => {
      if (activePopover === pop) {
        searchInput.focus({ preventScroll: true });
      }
    });
  }

  pop.addEventListener("click", (ev) => {
    const optBtn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-cselect-option]");
    if (!optBtn || optBtn.disabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    const val = optBtn.dataset.cselectOption ?? "";
    let targetTrigger = activeTrigger;
    const savedKey = activeTriggerKey;
    closeCanvasSelectPopover();
    if ((!targetTrigger || !targetTrigger.isConnected) && savedKey) {
      targetTrigger = findMatchingLiveCanvasTrigger(savedKey);
    }
    if (targetTrigger && targetTrigger.isConnected) {
      targetTrigger.dispatchEvent(
        new CustomEvent<CanvasSelectChangeDetail>("canvas-select-change", {
          bubbles: true,
          detail: { value: val },
        })
      );
    }
  });
}

export function ensureCanvasSelectGlobalBinding(): void {
  if (boundGlobal || typeof document === "undefined") return;
  boundGlobal = true;

  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const trigger = target.closest<HTMLElement>("[data-cselect-trigger]");
      if (trigger) {
        e.preventDefault();
        e.stopPropagation();
        openForTrigger(trigger);
        return;
      }
      if (activePopover && !target.closest("[data-cselect-popover]")) {
        closeCanvasSelectPopover();
      }
    },
    true
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!activePopover) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        !target.closest("[data-cselect-popover]") &&
        !target.closest("[data-cselect-trigger]")
      ) {
        closedOnPointerDownKey = activeTriggerKey;
        closedOnPointerDownAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        closeCanvasSelectPopover();
      }
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activePopover) {
      e.stopPropagation();
      closeCanvasSelectPopover();
    }
  });

  window.addEventListener(
    "wheel",
    (e) => {
      if (!activePopover) return;
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest("[data-cselect-popover]")) {
        closeCanvasSelectPopover();
      }
    },
    { passive: true, capture: true }
  );

  window.addEventListener("resize", () => {
    if (activePopover) closeCanvasSelectPopover();
  });
}
