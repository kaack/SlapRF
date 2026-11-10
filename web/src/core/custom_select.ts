import { esc } from "./format";

let activePopover: HTMLElement | null = null;
let activeSelect: HTMLSelectElement | null = null;
let cleanupListeners: (() => void) | null = null;

const upgradedSelects = new WeakMap<
  HTMLSelectElement,
  {
    wrapper: HTMLElement;
    trigger: HTMLButtonElement;
    labelSpan: HTMLElement;
    sync: () => void;
  }
>();

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
    const state = upgradedSelects.get(activeSelect);
    if (state) {
      state.trigger.classList.remove("is-custom-select-open");
      state.trigger.setAttribute("aria-expanded", "false");
    }
    activeSelect = null;
  }
}

function positionPopover(anchorEl: HTMLElement, popover: HTMLElement): void {
  const rect = anchorEl.getBoundingClientRect();
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

  const state = upgradedSelects.get(selectEl);
  const anchorEl = state ? state.trigger : selectEl;

  activeSelect = selectEl;
  selectEl.classList.add("is-custom-open");
  if (state) {
    state.trigger.classList.add("is-custom-select-open");
    state.trigger.setAttribute("aria-expanded", "true");
  }

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
        <span class="custom-select-opt-text">${esc(opt.textContent ?? opt.label)}</span>
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
  positionPopover(anchorEl, popover);

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
    state?.sync();
    closeCustomSelect();
    if (changed) {
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (!t) return;
    if (popover.contains(t) || anchorEl.contains(t) || selectEl.contains(t)) return;
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
    positionPopover(anchorEl, popover);
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

function upgradeSelectElement(selectEl: HTMLSelectElement): void {
  const existing = upgradedSelects.get(selectEl);
  if (existing) {
    existing.sync();
    return;
  }
  const parent = selectEl.parentElement;
  if (!parent) return;

  const wrapper = document.createElement("div");
  wrapper.className = "custom-select-wrap";
  if (selectEl.classList.contains("gate-timer-select")) {
    wrapper.classList.add("gate-timer-select");
  }

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "input custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const labelSpan = document.createElement("span");
  labelSpan.className = "custom-select-trigger-label";

  const caretSpan = document.createElement("span");
  caretSpan.className = "custom-select-trigger-caret";
  caretSpan.setAttribute("aria-hidden", "true");

  trigger.appendChild(labelSpan);
  trigger.appendChild(caretSpan);

  parent.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);
  wrapper.appendChild(trigger);

  selectEl.classList.add("is-custom-upgraded");
  selectEl.tabIndex = -1;

  const sync = () => {
    const selectedOpt = selectEl.selectedOptions[0] ?? selectEl.options[selectEl.selectedIndex];
    labelSpan.textContent = selectedOpt ? (selectedOpt.textContent ?? selectedOpt.label) : "";
    trigger.disabled = selectEl.disabled;
    trigger.title = selectEl.title || "";
    trigger.classList.toggle("mono", selectEl.classList.contains("mono"));
    trigger.classList.toggle("input-warn", selectEl.classList.contains("input-warn"));
    if (selectEl.getAttribute("aria-label")) {
      trigger.setAttribute("aria-label", selectEl.getAttribute("aria-label")!);
    }
  };

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCustomSelect(selectEl);
  });

  selectEl.addEventListener("change", sync);
  const mo = new MutationObserver(sync);
  mo.observe(selectEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "class", "title", "value"],
  });

  const state = { wrapper, trigger, labelSpan, sync };
  upgradedSelects.set(selectEl, state);
  sync();
}

/**
 * Replaces every `select.input` with a real `<button class="input custom-select-trigger">`
 * while keeping the hidden `<select>` in the DOM for `FormData` and `change` events.
 * Because the user taps a `<button>`, Android and iOS NEVER open their native system `<select>` modal.
 */
export function installCustomSelects(): void {
  let scanning = false;
  const scan = (root: ParentNode = document) => {
    if (scanning) return;
    scanning = true;
    try {
      root.querySelectorAll<HTMLSelectElement>("select.input").forEach((sel) => {
        upgradeSelectElement(sel);
      });
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
          !node.classList.contains("custom-select-wrap") &&
          !node.classList.contains("custom-select-trigger") &&
          !node.classList.contains("custom-select-popover")
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
}
