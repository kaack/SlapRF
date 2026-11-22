import { esc } from "../core/format";
import { icons } from "../core/icons";
import { getPairedBluetoothHub, TimerConsole } from "../services/timer_console";

export interface DeviceConnectionSheetOptions {
  console: TimerConsole;
  bluetoothMode: boolean;
  onAfterAction?: () => void;
}

let activeSheetCleanup: (() => void) | null = null;

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(max-width: 760px)").matches;
  }
  return window.innerWidth <= 760;
}

/**
 * Opens the connected timer action menu:
 * - Desktop (`> 760px`): centered modal dialog (`Disconnect` and, in Bluetooth mode, `Forget Device`).
 * - Mobile (`<= 760px`): bottom sheet drawer with swipe-to-dismiss (`Disconnect` / `Forget Device`).
 */
export function openDeviceConnectionSheet(opts: DeviceConnectionSheetOptions): void {
  if (activeSheetCleanup) {
    activeSheetCleanup();
  }

  const c = opts.console;
  const s = c.lastStatus;
  const cfg = c.lastConfig;
  const isBle = Boolean(opts.bluetoothMode || c.transportLabel === "Bluetooth");
  const paired = isBle ? getPairedBluetoothHub() : null;
  const isOther = c.isOtherDevice;
  const isSpoke = s ? s.role === 2 : cfg?.role === "spoke";
  const label = isOther
    ? "USB Device"
    : s?.label || cfg?.timerLabel || paired?.label || (isSpoke ? "Spoke" : "H1");
  const roleLabel = isOther
    ? "Unflashed"
    : isSpoke
      ? `Spoke${s?.slot ? ` · Slot ${s.slot}` : ""}`
      : "Hub";
  const transportLabel = isBle ? "Bluetooth" : "USB-C";
  const fp = (s?.fp || cfg?.fingerprint || paired?.fp || "").trim().toUpperCase();
  const metaLine = `${roleLabel} · ${transportLabel}${fp ? ` · ${fp}` : ""}`;

  const actionsHtml = `
    <div class="device-conn-actions">
      <button type="button" class="device-conn-action" data-conn-action="disconnect">
        <span class="device-conn-action-icon">${icons.plugOff(18)}</span>
        <span class="device-conn-action-copy">
          <strong>Disconnect</strong>
          <span>${
            isBle
              ? `Disconnect for now while keeping ${esc(label)} paired to this device.`
              : `Close the USB-C connection to ${esc(label)}.`
          }</span>
        </span>
      </button>
      ${
        isBle
          ? `<button type="button" class="device-conn-action is-forget" data-conn-action="forget">
               <span class="device-conn-action-icon">${icons.trash(18)}</span>
               <span class="device-conn-action-copy">
                 <strong>Forget Device</strong>
                 <span>Clear Bluetooth pairing on ${esc(label)} so another phone, computer, or Raspberry Pi can pair.</span>
               </span>
             </button>`
          : ""
      }
    </div>`;

  const mobile = isMobileViewport();
  const root = document.createElement("div");

  if (mobile) {
    root.className = "pilot-dir-mobile-drawer-overlay mre-sheet-overlay device-conn-drawer-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", `${label} connection options`);
    root.innerHTML = `
      <div class="pilot-dir-mobile-drawer-backdrop" data-conn-sheet-close></div>
      <div class="pilot-dir-mobile-editor is-entering mre-bottom-sheet device-conn-drawer" role="document">
        <div class="mre-sheet-head" data-conn-sheet-drag>
          <div class="mre-sheet-grip-row">
            <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
          </div>
          <div class="mre-sheet-title-row">
            <div class="device-conn-head-titles">
              <strong>${esc(label)}</strong>
              <span class="device-conn-head-meta">${esc(metaLine)}</span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-conn-sheet-close aria-label="Close">
              ${icons.close(15)}
            </button>
          </div>
        </div>
        <div class="mre-sheet-body">${actionsHtml}</div>
        <div class="mre-sheet-foot">
          <button type="button" class="btn btn-ghost device-conn-cancel-mobile" data-conn-sheet-close>Cancel</button>
        </div>
      </div>`;
  } else {
    root.className = "slaprf-modal-backdrop device-conn-modal-backdrop";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", `${label} connection options`);
    root.innerHTML = `
      <div class="slaprf-modal card device-conn-modal" role="document">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <span class="slaprf-modal-icon">
              ${isBle ? icons.wifi(17) : icons.plug(17)}
            </span>
            <div class="device-conn-head-titles">
              <h3>${esc(label)}</h3>
              <span class="device-conn-head-meta">${esc(metaLine)}</span>
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" data-conn-sheet-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
        <div class="slaprf-modal-body">${actionsHtml}</div>
        <div class="slaprf-modal-foot">
          <button type="button" class="btn btn-ghost" data-conn-sheet-close>Cancel</button>
        </div>
      </div>`;
  }

  let closed = false;
  const sheetEl = root.querySelector<HTMLElement>(".device-conn-drawer");

  const close = (immediate = false): void => {
    if (closed) {
      if (immediate && root.parentNode) {
        root.remove();
      }
      return;
    }
    closed = true;
    window.removeEventListener("keydown", onKeyDown, true);
    if (activeSheetCleanup === cleanupImmediate) {
      activeSheetCleanup = null;
    }
    if (!mobile || immediate || !root.parentNode) {
      root.remove();
      return;
    }
    root.removeAttribute("role");
    root.removeAttribute("aria-modal");
    root.setAttribute("aria-hidden", "true");
    sheetEl?.classList.remove("is-entering");
    root.classList.add("is-closing");
    window.setTimeout(() => {
      root.remove();
    }, 200);
  };

  const cleanupImmediate = (): void => close(true);
  activeSheetCleanup = cleanupImmediate;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  let busy = false;
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t === root || t.hasAttribute("data-conn-sheet-close") || t.closest("[data-conn-sheet-close]")) {
      if (!busy) close(false);
      return;
    }
    const actionBtn = t.closest<HTMLButtonElement>("[data-conn-action]");
    if (!actionBtn || busy) return;
    const action = actionBtn.dataset.connAction;
    if (action !== "disconnect" && action !== "forget") return;

    busy = true;
    root.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled = true;
    });

    const run =
      action === "forget" ? c.forgetBluetoothDevice() : c.disconnectCleanly();
    Promise.resolve(run)
      .catch(() => undefined)
      .finally(() => {
        close(true);
        opts.onAfterAction?.();
      });
  });

  if (mobile && sheetEl) {
    const dragHandle = root.querySelector<HTMLElement>("[data-conn-sheet-drag]");
    if (dragHandle) {
      let dragStartY: number | null = null;
      dragHandle.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length === 1) {
            dragStartY = e.touches[0].clientY;
          }
        },
        { passive: true }
      );
      dragHandle.addEventListener(
        "touchend",
        (e) => {
          if (dragStartY !== null && e.changedTouches.length > 0) {
            const dy = e.changedTouches[0].clientY - dragStartY;
            dragStartY = null;
            if (dy > 36 && !busy) {
              close(false);
            }
          }
        },
        { passive: true }
      );
    }
  }

  document.body.appendChild(root);
  const firstAction = root.querySelector<HTMLButtonElement>('[data-conn-action="disconnect"]');
  if (!mobile) {
    firstAction?.focus();
  }
}
