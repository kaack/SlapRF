import { esc } from "./format";

let activePopover: HTMLElement | null = null;
let activeSelect: HTMLSelectElement | null = null;
let activeAnchor: HTMLElement | null = null;
let activeSelectKey = "";
let cleanupListeners: (() => void) | null = null;

// Guards against a single pointer gesture closing on `pointerdown` (e.g. via a wrapping <label>
// or freshly re-rendered trigger) and immediately reopening on the synthesized/subsequent `click`.
let closedOnPointerDownSelect: HTMLSelectElement | null = null;
let closedOnPointerDownKey = "";
let closedOnPointerDownAt = 0;

const upgradedSelects = new WeakMap<
  HTMLSelectElement,
  {
    wrapper: HTMLElement;
    trigger: HTMLButtonElement;
    labelSpan: HTMLElement;
    sync: () => void;
  }
>();

function computeSelectIdentityKey(selectEl: HTMLSelectElement): string {
  const parts: string[] = [];
  if (selectEl.id) parts.push(`id:${selectEl.id}`);
  if (selectEl.name) parts.push(`name:${selectEl.name}`);
  const aria = selectEl.getAttribute("aria-label");
  if (aria) parts.push(`aria:${aria}`);

  const dsKeys = Object.keys(selectEl.dataset).sort();
  for (const k of dsKeys) {
    parts.push(`d:${k}=${selectEl.dataset[k] ?? ""}`);
  }

  const form = selectEl.closest<HTMLFormElement>("form");
  if (form) {
    if (form.dataset.pilot) parts.push(`pilot:${form.dataset.pilot}`);
    if (form.classList.contains("pilot-dir-mobile-form")) parts.push("mobile-form");
    if (form.id) parts.push(`form:${form.id}`);
  }

  const scoped = selectEl.closest<HTMLElement>(
    "[data-session-pilot-row], [data-gate-id], [data-slot]"
  );
  if (scoped) {
    if (scoped.dataset.sessionPilotRow) parts.push(`sprow:${scoped.dataset.sessionPilotRow}`);
    if (scoped.dataset.gateId) parts.push(`gate:${scoped.dataset.gateId}`);
    if (scoped.dataset.slot) parts.push(`slot:${scoped.dataset.slot}`);
  }

  return parts.join("|");
}

function findMatchingLiveSelect(key: string): HTMLSelectElement | null {
  if (!key || typeof document === "undefined") return null;
  const all = document.querySelectorAll<HTMLSelectElement>("select.input");
  for (const sel of Array.from(all)) {
    if (document.body.contains(sel) && computeSelectIdentityKey(sel) === key) {
      return sel;
    }
  }
  return null;
}

export function isCustomSelectOpenWithin(container: ParentNode | null | undefined): boolean {
  if (!container || !activePopover || !activeSelect) return false;
  if (container.contains(activeSelect)) return true;
  if (activeAnchor && container.contains(activeAnchor)) return true;
  return false;
}

export function closeCustomSelect(): void {
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  if (activeAnchor) {
    activeAnchor.classList.remove("is-custom-select-open");
    activeAnchor.setAttribute("aria-expanded", "false");
    activeAnchor = null;
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
  activeSelectKey = "";
}

function positionPopover(anchorEl: HTMLElement, popover: HTMLElement): void {
  const rect = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 10;

  const minW = Math.min(vw - margin * 2, Math.max(rect.width, 200));
  const maxW = vw - margin * 2;
  popover.style.minWidth = `${Math.round(minW)}px`;
  popover.style.maxWidth = `${Math.round(maxW)}px`;

  const popRect = popover.getBoundingClientRect();
  const popW = Math.min(maxW, Math.max(minW, popRect.width || minW));

  let left = rect.width < 100 ? rect.right - popW : rect.left;
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

function targetMatchesSelectOrTrigger(
  t: Node,
  selectEl: HTMLSelectElement,
  anchorEl: HTMLElement,
  identityKey: string
): boolean {
  if (anchorEl.contains(t) || selectEl.contains(t)) return true;
  if (t instanceof Element) {
    const wrappingLabel = anchorEl.closest("label");
    if (wrappingLabel && wrappingLabel.contains(t)) return true;
    const clickedWrap = t.closest<HTMLElement>(".custom-select-wrap");
    if (clickedWrap) {
      const innerSel = clickedWrap.querySelector<HTMLSelectElement>("select.input");
      if (innerSel) {
        if (innerSel === selectEl) return true;
        if (identityKey && computeSelectIdentityKey(innerSel) === identityKey) return true;
      }
    }
  }
  return false;
}

export function openCustomSelect(
  selectEl: HTMLSelectElement,
  customAnchor?: HTMLElement
): void {
  if (selectEl.disabled) return;
  const state = upgradedSelects.get(selectEl);
  const anchorEl = customAnchor ?? (state ? state.trigger : selectEl);
  const incomingKey = computeSelectIdentityKey(selectEl);

  // If the popover for this exact select (or its re-rendered replacement with the same identity key)
  // is currently open, toggle it CLOSED cleanly instead of reopening!
  if (
    activePopover &&
    (activeSelect === selectEl ||
      activeAnchor === anchorEl ||
      (incomingKey !== "" && activeSelectKey === incomingKey))
  ) {
    closeCustomSelect();
    return;
  }

  // If `pointerdown` just closed this exact control moments ago in the same click gesture,
  // do NOT immediately reopen it on `click`.
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (
    closedOnPointerDownAt > 0 &&
    now - closedOnPointerDownAt < 350 &&
    (closedOnPointerDownSelect === selectEl ||
      (incomingKey !== "" && closedOnPointerDownKey === incomingKey))
  ) {
    closedOnPointerDownSelect = null;
    closedOnPointerDownKey = "";
    closedOnPointerDownAt = 0;
    return;
  }
  closedOnPointerDownSelect = null;
  closedOnPointerDownKey = "";
  closedOnPointerDownAt = 0;

  closeCustomSelect();

  activeSelect = selectEl;
  activeAnchor = anchorEl;
  activeSelectKey = incomingKey;
  selectEl.classList.add("is-custom-open");
  anchorEl.classList.add("is-custom-select-open");
  anchorEl.setAttribute("aria-expanded", "true");
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
        data-opt-value="${esc(opt.value)}"
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

    // Resolve live target `<select>` even if parent re-rendered while popover was open
    let targetSel = activeSelect ?? selectEl;
    if (!document.body.contains(targetSel) && activeSelectKey) {
      targetSel = findMatchingLiveSelect(activeSelectKey) ?? targetSel;
    }

    const idx = Number(btn.dataset.optIndex);
    const optVal = btn.dataset.optValue;
    let opt = targetSel.options[idx];
    if ((!opt || (optVal !== undefined && opt.value !== optVal)) && optVal !== undefined) {
      const matchIdx = Array.from(targetSel.options).findIndex((o) => o.value === optVal);
      if (matchIdx >= 0) {
        opt = targetSel.options[matchIdx];
      }
    }
    if (!opt) return;

    const targetIdx = Array.from(targetSel.options).indexOf(opt);
    const changed = targetSel.selectedIndex !== targetIdx || targetSel.value !== opt.value;
    targetSel.selectedIndex = targetIdx;
    targetSel.value = opt.value;
    upgradedSelects.get(targetSel)?.sync();
    closeCustomSelect();
    if (changed) {
      targetSel.dispatchEvent(new Event("input", { bubbles: true }));
      targetSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (!t) return;
    if (popover.contains(t)) return;
    const curSel = activeSelect ?? selectEl;
    const curAnchor = activeAnchor ?? anchorEl;
    if (targetMatchesSelectOrTrigger(t, curSel, curAnchor, activeSelectKey)) {
      closedOnPointerDownSelect = curSel;
      closedOnPointerDownKey = activeSelectKey;
      closedOnPointerDownAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      closeCustomSelect();
      return;
    }
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
    const curSel = activeSelect ?? selectEl;
    if (!document.body.contains(curSel)) {
      const replacement = activeSelectKey ? findMatchingLiveSelect(activeSelectKey) : null;
      if (replacement) {
        const repState = upgradedSelects.get(replacement);
        activeSelect = replacement;
        activeAnchor = repState ? repState.trigger : replacement;
        activeSelect.classList.add("is-custom-open");
        activeAnchor.classList.add("is-custom-select-open");
        activeAnchor.setAttribute("aria-expanded", "true");
      } else {
        closeCustomSelect();
        return;
      }
    }
    positionPopover(activeAnchor ?? anchorEl, popover);
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

  // Place `trigger` BEFORE `selectEl` so any wrapping `<label>` associates with `trigger`
  // rather than synthesizing competing clicks onto the hidden `<select>`.
  parent.insertBefore(wrapper, selectEl);
  wrapper.appendChild(trigger);
  wrapper.appendChild(selectEl);

  selectEl.classList.add("is-custom-upgraded");
  selectEl.setAttribute("aria-hidden", "true");
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

function reconcileOpenSelectAfterMutation(): void {
  if (!activePopover || !activeSelect) return;
  if (document.body.contains(activeSelect)) return;

  if (activeSelectKey) {
    const replacement = findMatchingLiveSelect(activeSelectKey);
    if (replacement) {
      const repState = upgradedSelects.get(replacement);
      activeSelect = replacement;
      activeAnchor = repState ? repState.trigger : replacement;
      activeSelect.classList.add("is-custom-open");
      activeAnchor.classList.add("is-custom-select-open");
      activeAnchor.setAttribute("aria-expanded", "true");
      positionPopover(activeAnchor, activePopover);
      return;
    }
  }
  closeCustomSelect();
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
      reconcileOpenSelectAfterMutation();
    } finally {
      scanning = false;
    }
  };

  scan(document);

  const mo = new MutationObserver((mutations) => {
    if (scanning) return;
    let shouldScan = false;
    let hadRemovals = false;
    for (const m of mutations) {
      if (m.removedNodes.length > 0) {
        hadRemovals = true;
      }
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
    } else if (hadRemovals && activePopover) {
      reconcileOpenSelectAfterMutation();
    }
  });

  mo.observe(document.body, { childList: true, subtree: true });
}
