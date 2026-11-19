import { esc } from "./format";
import { icons } from "./icons";

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
  popover.classList.toggle(
    "is-pilot-select-popover",
    selectEl.classList.contains("mre-seat-pilot-select")
  );
  popover.setAttribute("role", "listbox");

  const renderOption = (opt: HTMLOptionElement, idx: number): string => {
    const isSelected = opt.selected || opt.value === selectEl.value;
    const isDisabled = opt.disabled;
    const dotColor = opt.dataset.dot || "";
    const subLabel = opt.dataset.sub || "";
    const hasSwap = opt.dataset.swap === "1";
    const swapTitle = opt.dataset.swapTitle || "Channel changed";
    const dotHtml = dotColor
      ? dotColor === "hollow"
        ? `<span class="dot custom-select-dot is-hollow"></span>`
        : `<span class="dot custom-select-dot" style="--c:${esc(dotColor)}"></span>`
      : "";
    const swapHtml = hasSwap
      ? `<span class="custom-select-swap-ico" title="${esc(swapTitle)}">${icons.channelSwap(13)}</span>`
      : "";
    const subHtml = subLabel
      ? `<span class="custom-select-opt-sub mono">${esc(subLabel)}</span>`
      : "";
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
        <span class="custom-select-opt-text">${dotHtml}<span class="custom-select-opt-main">${esc(opt.textContent ?? opt.label)}</span>${swapHtml}${subHtml}</span>
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
  for (const layoutCls of ["gate-timer-select", "mre-seat-ch-select", "mre-seat-pilot-select"]) {
    if (selectEl.classList.contains(layoutCls)) {
      wrapper.classList.add(layoutCls);
    }
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
    const txt = selectedOpt ? (selectedOpt.textContent ?? selectedOpt.label) : "";
    const dotColor = selectedOpt?.dataset.dot || "";
    const subLabel = selectedOpt?.dataset.sub || "";
    const hasSwap = selectedOpt?.dataset.swap === "1";
    const swapTitle = selectedOpt?.dataset.swapTitle || "Channel changed";
    if (dotColor || subLabel || hasSwap) {
      const dotHtml = dotColor
        ? dotColor === "hollow"
          ? `<span class="dot custom-select-dot is-hollow"></span>`
          : `<span class="dot custom-select-dot" style="--c:${esc(dotColor)}"></span>`
        : "";
      const swapHtml = hasSwap
        ? `<span class="custom-select-swap-ico" title="${esc(swapTitle)}">${icons.channelSwap(13)}</span>`
        : "";
      const subHtml = subLabel
        ? `<span class="custom-select-sub mono">${esc(subLabel)}</span>`
        : "";
      const nextHtml = `${dotHtml}<span class="custom-select-main-text">${esc(txt)}</span>${swapHtml}${subHtml}`;
      if (labelSpan.innerHTML !== nextHtml) {
        labelSpan.innerHTML = nextHtml;
      }
      labelSpan.classList.add("has-rich-content");
    } else {
      if (labelSpan.classList.contains("has-rich-content") || labelSpan.textContent !== txt) {
        labelSpan.textContent = txt;
      }
      labelSpan.classList.remove("has-rich-content");
    }
    trigger.disabled = selectEl.disabled;
    trigger.title = selectEl.title || "";
    trigger.classList.toggle("mono", selectEl.classList.contains("mono"));
    trigger.classList.toggle("input-warn", selectEl.classList.contains("input-warn"));
    trigger.classList.toggle("input-sm", selectEl.classList.contains("input-sm"));
    trigger.classList.toggle("is-seed-placeholder", selectEl.classList.contains("is-seed-placeholder"));
    trigger.classList.toggle("is-heat-placeholder", selectEl.classList.contains("is-heat-placeholder"));
    trigger.classList.toggle("is-bye-placeholder", selectEl.classList.contains("is-bye-placeholder"));
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
    attributeFilter: [
      "disabled",
      "class",
      "title",
      "value",
      "data-dot",
      "data-sub",
      "data-swap",
      "data-swap-title",
    ],
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
function installModalCloseAnimations(): void {
  if (typeof document === "undefined" || typeof Element === "undefined") return;
  let internalRemove = false;

  // Intercept innerHTML setter on modal backdrops so only the very first mount
  // animates `.slaprf-modal` / `.confirm-modal`, and any subsequent re-renders
  // while the modal is open update in place without re-playing the entrance animation.
  const elemProto = Element.prototype;
  const htmlDesc =
    Object.getOwnPropertyDescriptor(elemProto, "innerHTML") ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerHTML");
  if (htmlDesc && htmlDesc.set && htmlDesc.get) {
    const origSet = htmlDesc.set;
    const origGet = htmlDesc.get;
    Object.defineProperty(elemProto, "innerHTML", {
      configurable: true,
      enumerable: htmlDesc.enumerable ?? true,
      get() {
        return origGet.call(this);
      },
      set(val: string) {
        if (
          this instanceof HTMLElement &&
          (this.classList.contains("slaprf-modal-backdrop") ||
            this.classList.contains("confirm-modal-backdrop"))
        ) {
          if (this.dataset.modalMountedOnce === "1") {
            this.classList.add("is-entered");
          } else {
            this.dataset.modalMountedOnce = "1";
          }
        }
        origSet.call(this, val);
      },
    });
  }

  const shouldAnimateClose = (node: unknown): node is HTMLElement => {
    if (internalRemove) return false;
    if (!(node instanceof HTMLElement)) return false;
    if (!document.body || node.parentNode !== document.body) return false;
    if (
      !node.classList.contains("slaprf-modal-backdrop") &&
      !node.classList.contains("confirm-modal-backdrop")
    ) {
      return false;
    }
    if (node.classList.contains("is-closing")) return false;
    // Skip animation if another modal is replacing it in the same frame or in headless unit tests
    if (
      typeof window !== "undefined" &&
      ((window as { __SLAPRF_E2E_FAST_BOOT__?: boolean }).__SLAPRF_E2E_FAST_BOOT__ ||
        document.getElementById("test-root") !== null)
    ) {
      return false;
    }
    return true;
  };

  const animateModalOut = (el: HTMLElement): void => {
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add("is-closing");
    ghost.setAttribute("aria-hidden", "true");
    ghost.removeAttribute("role");
    ghost.removeAttribute("aria-modal");
    internalRemove = true;
    try {
      document.body.appendChild(ghost);
    } finally {
      internalRemove = false;
    }
    window.setTimeout(() => {
      internalRemove = true;
      try {
        ghost.remove();
      } finally {
        internalRemove = false;
      }
    }, 195);
  };

  const origRemove = Element.prototype.remove;
  Element.prototype.remove = function (this: Element) {
    if (shouldAnimateClose(this)) {
      animateModalOut(this);
    }
    return origRemove.call(this);
  };

  const origRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (shouldAnimateClose(child)) {
      animateModalOut(child);
    }
    return origRemoveChild.call(this, child) as T;
  };
}

let scanningSelects = false;

export function scanCustomSelects(root: ParentNode = document): void {
  if (scanningSelects) return;
  scanningSelects = true;
  try {
    root.querySelectorAll<HTMLSelectElement>("select.input").forEach((sel) => {
      upgradeSelectElement(sel);
    });
    document
      .querySelectorAll<HTMLElement>(
        ".slaprf-modal-backdrop:not(.is-closing):not(.is-entered), .confirm-modal-backdrop:not(.is-closing):not(.is-entered)"
      )
      .forEach((bd) => {
        if (bd.dataset.enterQueued === "1") return;
        bd.dataset.enterQueued = "1";
        window.setTimeout(() => {
          bd.classList.add("is-entered");
        }, 270);
      });
    reconcileOpenSelectAfterMutation();
  } finally {
    scanningSelects = false;
  }
}

export function installCustomSelects(): void {
  installModalCloseAnimations();

  scanCustomSelects(document);

  const mo = new MutationObserver((mutations) => {
    if (scanningSelects) return;
    let shouldScan = false;
    let hadRemovals = false;
    for (const m of mutations) {
      if (m.target instanceof Element && m.target.closest(".custom-select-trigger")) {
        continue;
      }
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
      scanCustomSelects(document);
    } else if (hadRemovals && activePopover) {
      reconcileOpenSelectAfterMutation();
    }
  });

  mo.observe(document.body, { childList: true, subtree: true });
}
