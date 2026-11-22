/**
 * Smooth, GPU-composited keyboard avoidance for mobile bottom drawers and modals.
 *
 * On Android (`SlapRFHost.java`), `WindowInsetsAnimation.Callback.onStart` calls
 * `window.__slaprfSetKbOffset(kbCssPx, durationMs, showing)` once per keyboard
 * transition so Chromium's GPU compositor animates the individual `translate`
 * property at full display refresh rate (60/120 Hz) with zero per-frame layout
 * reflows, root style recalculations, or cross-thread IPC jitter.
 *
 * On mobile browsers without `SlapRFAndroid` (e.g. iOS Safari / mobile Chrome),
 * falls back to `window.visualViewport` geometry when an input inside a drawer
 * or modal is focused.
 */

declare global {
  interface Window {
    __slaprfSetKbOffset?: (kbCssPx: number, durationMs?: number, showing?: boolean) => void;
    SlapRFAndroid?: unknown;
  }
}

const BOTTOM_SHEET_SELECTOR = [
  ".pilot-dir-mobile-drawer-overlay:not([hidden]):not(.is-closing) .pilot-dir-mobile-editor",
  ".scope-tune-drawer:not([hidden]):not(.is-mobile-closed):not(.is-closing)",
  ".practice-pilot-drawer-overlay:not([hidden]):not(.is-closing) .practice-pilot-popover",
  ".mre-sheet-overlay:not([hidden]):not(.is-closing) .mre-bottom-sheet",
].join(", ");

const MODAL_SELECTOR = [
  ".slaprf-modal-backdrop:not([hidden]):not(.is-closing) .slaprf-modal",
  ".confirm-modal-backdrop:not([hidden]):not(.is-closing) .confirm-modal",
  ".modal-backdrop:not([hidden]):not(.is-closing) .modal",
].join(", ");

const TOP_SAFE_CLEARANCE_PX = 52;
const MODAL_TOP_CLEARANCE_PX = 16;

let installed = false;

export function installMobileKeyboardShift(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  installed = true;

  let currentKbPx = 0;
  const trackedSheets = new Set<HTMLElement>();
  const restingHeightCache = new WeakMap<HTMLElement, number>();

  const computeEasing = (durationMs: number, showing: boolean): string => {
    if (!showing && durationMs > 0 && durationMs <= 210) {
      return "cubic-bezier(0.4, 0, 1, 1)";
    }
    return "cubic-bezier(0.2, 0, 0, 1)";
  };

  const computeSheetShiftPx = (el: HTMLElement, kbPx: number, isModal: boolean): number => {
    if (kbPx <= 0.5) return 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    let h = restingHeightCache.get(el);
    if (!h || h <= 0) {
      h = el.offsetHeight;
      if (h > 0) restingHeightCache.set(el, h);
    }
    if (isModal) {
      const restingTop = Math.max(0, (vh - h) * 0.5);
      return Math.min(kbPx * 0.5, Math.max(0, restingTop - MODAL_TOP_CLEARANCE_PX));
    }
    const restingTop = Math.max(0, vh - h);
    const maxShift = Math.max(0, restingTop - TOP_SAFE_CLEARANCE_PX);
    return Math.min(kbPx, maxShift);
  };

  const applyElementTranslate = (
    el: HTMLElement,
    shiftPx: number,
    durationMs: number,
    easing: string
  ): void => {
    const rounded = Math.round(shiftPx * 100) / 100;
    const nextTranslate = rounded > 0 ? `0px ${-rounded}px` : "0px";
    const nextTransition =
      durationMs > 0 ? `translate ${Math.round(durationMs)}ms ${easing}` : "none";

    if (el.style.transition !== nextTransition) {
      el.style.transition = nextTransition;
    }
    if (el.style.translate !== nextTranslate) {
      el.style.translate = nextTranslate;
    }
  };

  const cleanupIfSettledZero = (e: TransitionEvent): void => {
    if (e.propertyName !== "translate") return;
    const el = e.currentTarget;
    if (!(el instanceof HTMLElement)) return;
    if (currentKbPx <= 0.5) {
      el.style.translate = "";
      el.style.transition = "";
      restingHeightCache.delete(el);
      el.removeEventListener("transitionend", cleanupIfSettledZero);
      trackedSheets.delete(el);
    }
  };

  const syncAllSurfaces = (kbPx: number, durationMs = 0, showing = kbPx > currentKbPx): void => {
    const clampedKb = Number.isFinite(kbPx) && kbPx > 0 ? kbPx : 0;
    currentKbPx = clampedKb;
    const easing = computeEasing(durationMs, showing);

    const activeSheets = document.querySelectorAll<HTMLElement>(BOTTOM_SHEET_SELECTOR);
    const activeModals = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR);

    if (clampedKb <= 0.5) {
      for (const el of Array.from(trackedSheets)) {
        if (!el.isConnected) {
          trackedSheets.delete(el);
          continue;
        }
        if (durationMs > 0) {
          applyElementTranslate(el, 0, durationMs, easing);
        } else {
          el.style.translate = "";
          el.style.transition = "";
          restingHeightCache.delete(el);
          el.removeEventListener("transitionend", cleanupIfSettledZero);
          trackedSheets.delete(el);
        }
      }
      return;
    }

    activeSheets.forEach((el) => {
      if (!trackedSheets.has(el)) {
        trackedSheets.add(el);
        restingHeightCache.set(el, el.offsetHeight);
        el.addEventListener("transitionend", cleanupIfSettledZero);
      }
      const shift = computeSheetShiftPx(el, clampedKb, false);
      applyElementTranslate(el, shift, durationMs, easing);
    });

    activeModals.forEach((el) => {
      if (!trackedSheets.has(el)) {
        trackedSheets.add(el);
        restingHeightCache.set(el, el.offsetHeight);
        el.addEventListener("transitionend", cleanupIfSettledZero);
      }
      const shift = computeSheetShiftPx(el, clampedKb, true);
      applyElementTranslate(el, shift, durationMs, easing);
    });
  };

  window.__slaprfSetKbOffset = (kbCssPx: number, durationMs = 0, showing?: boolean): void => {
    const isShowing = showing !== undefined ? showing : kbCssPx > currentKbPx;
    syncAllSurfaces(kbCssPx, durationMs, isShowing);
  };

  // If a new drawer opens or focus moves while the keyboard is already visible, ensure it is shifted.
  document.addEventListener(
    "focusin",
    () => {
      if (currentKbPx > 0.5) {
        syncAllSurfaces(currentKbPx, 0, true);
      }
    },
    true
  );

  // Browser fallback (iOS Safari / mobile Chrome) when native Android bridge is not present.
  const vv = window.visualViewport;
  if (vv && !window.SlapRFAndroid) {
    const onVisualViewportChange = (): void => {
      if (window.SlapRFAndroid) return;
      if (window.innerWidth > 860) {
        if (currentKbPx > 0) syncAllSurfaces(0, 180, false);
        return;
      }
      const layoutH = window.innerHeight || document.documentElement.clientHeight || 0;
      const kb = Math.max(0, layoutH - vv.height - vv.offsetTop);
      const effectiveKb = kb > 90 ? kb : 0;
      if (Math.abs(effectiveKb - currentKbPx) < 1) return;
      syncAllSurfaces(effectiveKb, 220, effectiveKb > currentKbPx);
    };
    vv.addEventListener("resize", onVisualViewportChange);
    vv.addEventListener("scroll", onVisualViewportChange);
  }
}
