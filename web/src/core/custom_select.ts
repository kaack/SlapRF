import { esc } from "./format";

let activePopover: HTMLElement | null = null;
let activeSelect: HTMLSelectElement | null = null;
let cleanupListeners: (() => void) | null = null;

function closeCustomSelect(): void {
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  if (activeSelect) {
    activeSelect.classList.remove("is-custom-open");
    activeSelect = null;
  }
}

function positionPopover(selectEl: HTMLSelectElement, popover: HTMLElement): void {
  const rect = selectEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 10;

  const minW = Math.min(vw - margin * 2, Math.max(rect.width, 220));
  const maxW = vw - margin * 2;
  popover.style.minWidth = `${Math.round(minW)}px`;
  popover.style.maxWidth = `${Math.round(maxW)}px`;

  const popRect = popover.getBoundingClientRect();
  const popW = Math.min(maxW, Math.max(minW, popRect.width || minW));

  let left = rect.left;
  if (left + popW > vw - margin) {
    left = Math.max(margin, vw - margin - popW);
  }
  left = Math.max(margin, left);

  const spaceBelow = vh - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openAbove = spaceBelow < 200 && spaceAbove > spaceBelow;
  const availH = Math.max(140, Math.min(320, openAbove ? spaceAbove - 6 : spaceBelow - 6));
  popover.style.maxHeight = `${Math.round(availH)}px`;
  popover.style.left = `${Math.round(left)}px`;

  if (openAbove) {
    popover.style.top = "auto";
    popover.style.bottom = `${Math.round(vh - rect.top + 6)}px`;
  } else {
    popover.style.bottom = "auto";
    popover.style.top = `${Math.round(rect.bottom + 6)}px`;
  }
}

function openCustomSelect(selectEl: HTMLSelectElement): void {
  if (selectEl.disabled) return;
  if (activeSelect === selectEl) {
    closeCustomSelect();
    return;
  }
  closeCustomSelect();

  activeSelect = selectEl;
  selectEl.classList.add("is-custom-open");

  const popover = document.createElement("div");
  popover.className = "custom-select-popover";
  popover.setAttribute("role", "listbox");

  const renderOption = (opt: HTMLOptionElement, idx: number): string => {
    const isSelected = opt.selected || opt.value === selectEl.value;
    const isDisabled = opt.disabled;
    return `
      <button
        type="button"
        role="option"
        class="custom-select-option ${isSelected ? "is-selected" : ""}"
        data-opt-index="${idx}"
        aria-selected="${isSelected}"
        ${isDisabled ? "disabled" : ""}
      >
        <span class="custom-select-opt-label">${esc(opt.textContent ?? opt.label)}</span>
        <span class="custom-select-opt-check" aria-hidden="true">${isSelected ? "✓" : ""}</span>
      </button>`;
  };

  const allOptions = Array.from(selectEl.options);
  let html = "";
  for (const child of Array.from(selectEl.children)) {
    if (child instanceof HTMLOptGroupElement) {
      const groupOpts = Array.from(child.children).filter(
        (c): c is HTMLOptionElement => c instanceof HTMLOptionElement
      );
      if (groupOpts.length === 0) continue;
      html += `
        <div class="custom-select-group">
          <div class="custom-select-group-label">${esc(child.label)}</div>
          ${groupOpts.map((opt) => renderOption(opt, allOptions.indexOf(opt))).join("")}
        </div>`;
    } else if (child instanceof HTMLOptionElement) {
      html += renderOption(child, allOptions.indexOf(child));
    }
  }

  popover.innerHTML = html;
  document.body.appendChild(popover);
  activePopover = popover;
  positionPopover(selectEl, popover);

  const selectedEl = popover.querySelector<HTMLElement>(".custom-select-option.is-selected");
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
  }

  popover.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-opt-index]");
    if (!btn || btn.disabled) return;
    const idx = Number(btn.dataset.optIndex);
    const opt = selectEl.options[idx];
    if (!opt) return;
    const changed = selectEl.selectedIndex !== idx || selectEl.value !== opt.value;
    selectEl.selectedIndex = idx;
    selectEl.value = opt.value;
    closeCustomSelect();
    if (changed) {
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (!t) return;
    if (popover.contains(t) || selectEl.contains(t)) return;
    closeCustomSelect();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCustomSelect();
    }
  };

  const onReposition = (e: Event) => {
    if (e.type === "scroll" && e.target instanceof Node && popover.contains(e.target)) {
      return;
    }
    if (!document.body.contains(selectEl)) {
      closeCustomSelect();
      return;
    }
    positionPopover(selectEl, popover);
  };

  window.addEventListener("pointerdown", onDocPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onReposition, { passive: true });
  window.addEventListener("scroll", onReposition, true);

  cleanupListeners = () => {
    window.removeEventListener("pointerdown", onDocPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onReposition);
    window.removeEventListener("scroll", onReposition, true);
  };
}

/**
 * Installs a global custom dropdown handler for all `select.input` elements so mobile
 * browsers (Android / iOS) and desktop browsers render a sleek theme-matched dropdown
 * popover instead of the oversized OS-native modal picker.
 */
export function installCustomSelects(): void {
  const findSelect = (e: Event): HTMLSelectElement | null => {
    const t = e.target;
    if (!(t instanceof Element)) return null;
    return t.closest<HTMLSelectElement>("select.input");
  };

  window.addEventListener(
    "mousedown",
    (e) => {
      const sel = findSelect(e);
      if (!sel) return;
      e.preventDefault();
      openCustomSelect(sel);
    },
    { passive: false }
  );

  window.addEventListener(
    "touchstart",
    (e) => {
      const sel = findSelect(e);
      if (!sel) return;
      // Prevent Android/iOS from opening the native system modal select
      e.preventDefault();
      openCustomSelect(sel);
    },
    { passive: false }
  );

  window.addEventListener(
    "click",
    (e) => {
      const sel = findSelect(e);
      if (!sel) return;
      e.preventDefault();
    },
    { passive: false }
  );

  window.addEventListener("keydown", (e) => {
    const sel = findSelect(e);
    if (!sel) return;
    if (e.key === " " || e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openCustomSelect(sel);
    }
  });
}
