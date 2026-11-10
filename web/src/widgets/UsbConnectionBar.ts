import { esc } from "../core/format";
import { icons } from "../core/icons";
import { TimerConsole, usbPool } from "../services/timer_console";

export interface UsbConnectionBarOptions {
  activeConsole: TimerConsole;
  showAllPorts: boolean;
  /** When true (Debug page only), allows swapping to a different USB device while keeping the main USB connection running. */
  allowSwap?: boolean;
  busyText?: string | null;
  error?: string | null;
}

const lastBarHtmlByHost = new WeakMap<HTMLElement, string>();

/**
 * Updates `host.innerHTML` with the USB connection bar only when the rendered markup changes,
 * preserving live DOM nodes and `:hover` state across 1 Hz status and 50 Hz live ticks.
 */
export function patchUsbConnectionBar(host: HTMLElement | null, opts: UsbConnectionBarOptions): void {
  if (!host) return;
  const html = renderUsbConnectionBarHtml(opts);
  if (lastBarHtmlByHost.get(host) === html && host.childElementCount > 0) {
    return;
  }
  lastBarHtmlByHost.set(host, html);
  host.innerHTML = html;
}

function renderChip(c: TimerConsole, active: boolean): string {
  const s = c.lastStatus;
  const cfg = c.lastConfig;
  const isOther = c.isOtherDevice;
  const isWriting = c.writing;
  const isSpoke = s ? s.role === 2 : cfg?.role === "spoke";
  const label = isOther
    ? "Other"
    : s?.label || cfg?.timerLabel || (s?.role === 1 || cfg?.role === "hub" ? "H1" : "USB");
  const roleMeta = isWriting
    ? "Writing…"
    : s
      ? s.emergencyMode
        ? "Emergency"
        : s.role === 1
          ? "Hub"
          : `Spoke${s.slot ? ` · slot ${s.slot}` : ""}`
      : cfg
        ? cfg.role === "hub"
          ? "Hub"
          : "Spoke"
        : isOther
          ? "Unflashed"
          : "Reading…";
  const chipColor = isOther
    ? "#f87171"
    : s?.emergencyMode
      ? "#facc15"
      : isSpoke
        ? "#38bdf8"
        : "#d4ff3a";
  const fp = s?.fp || cfg?.fingerprint || "";
  const fpNote = fp ? ` · ${fp}` : "";
  return `
    <div class="pilot-chip debug-usb-chip ${active ? "is-active" : ""} ${isWriting ? "is-writing" : ""}" style="--c:${chipColor}">
      <button
        type="button"
        class="debug-usb-chip-select"
        role="tab"
        aria-selected="${active}"
        data-action="select-usb-slot"
        data-usb-slot="${c.slotIndex}"
        title="${esc(label)} (${esc(roleMeta)}${esc(fpNote)})"
      >
        <span class="dot is-live"></span>
        <span class="pilot-chip-name">${esc(label)}</span>
        <span class="pilot-chip-time">${esc(roleMeta)}</span>
      </button>
      <button
        type="button"
        class="debug-usb-chip-close"
        data-action="disconnect-usb-slot"
        data-usb-slot="${c.slotIndex}"
        ${isWriting ? "disabled" : ""}
        title="Disconnect ${esc(label)}"
        aria-label="Disconnect ${esc(label)}"
      >${icons.close(13)}</button>
    </div>`;
}

/**
 * Renders the right-hand column of the 2-column "Connection" `<section class="settings-section">`
 * shared across Network, Flasher, and Debug pages.
 */
export function renderUsbConnectionBarHtml(opts: UsbConnectionBarOptions): string {
  const supported = TimerConsole.supported();
  const main = usbPool.mainConsole;
  const swapSlot = usbPool.slots[1];
  const poolBusy = usbPool.slots.find((c) => c.busyLabel)?.busyLabel ?? null;
  const busyText = opts.busyText || opts.activeConsole.busyLabel || poolBusy || "";
  const busy = busyText.length > 0;

  let chipsHtml = "";
  let actionBtnHtml = "";

  if (opts.allowSwap) {
    // Debug page: shows the currently inspected USB connection and a "Swap USB" button when connected.
    const c = opts.activeConsole;
    if (c.connected) {
      chipsHtml = renderChip(c, true);
      const isSwapped = c === swapSlot && main.connected;
      const mainLabel =
        main.lastStatus?.label || main.lastConfig?.timerLabel || (main.lastStatus?.role === 1 ? "H1" : "Main USB");
      actionBtnHtml = `
        <button
          type="button"
          class="pilot-chip debug-usb-add-chip"
          data-action="connect-add"
          ${supported && !busy ? "" : "disabled"}
          title="Swap this Debug window to inspect a different USB device while keeping ${esc(mainLabel)} connected"
        >
          ${icons.plug(20)}
          <span class="pilot-chip-name">${busy ? `${esc(busyText)}…` : "Swap USB"}</span>
        </button>
        ${
          isSwapped
            ? `<button
                type="button"
                class="pilot-chip debug-usb-add-chip"
                data-action="revert-usb-main"
                ${supported && !busy ? "" : "disabled"}
                title="Switch Debug back to main USB connection (${esc(mainLabel)})"
              >
                <span class="pilot-chip-name">Back to ${esc(mainLabel)}</span>
              </button>`
            : ""
        }`;
    } else {
      actionBtnHtml = `
        <button
          type="button"
          class="pilot-chip debug-usb-add-chip"
          data-action="connect-add"
          ${supported && !busy ? "" : "disabled"}
          title="Connect a USB device"
        >
          ${icons.plug(20)}
          <span class="pilot-chip-name">${busy ? `${esc(busyText)}…` : "Connect USB"}</span>
        </button>`;
    }
  } else {
    // Network & Flasher pages: strictly single main USB connection (Slot 0).
    if (main.connected) {
      chipsHtml = renderChip(main, true);
    } else {
      actionBtnHtml = `
        <button
          type="button"
          class="pilot-chip debug-usb-add-chip"
          data-action="connect-add"
          ${supported && !busy ? "" : "disabled"}
          title="Connect a USB device"
        >
          ${icons.plug(20)}
          <span class="pilot-chip-name">${busy ? `${esc(busyText)}…` : "Connect USB"}</span>
        </button>`;
    }
  }

  const bannerParts: string[] = [];
  if (!supported) {
    bannerParts.push(`<div class="sim-error-note">USB connection needs Chrome, Edge or Brave (WebSerial).</div>`);
  }
  if (opts.error) {
    bannerParts.push(`<div class="sim-error-note">${esc(opts.error)}</div>`);
  }

  return `
    <div class="picker-row debug-usb-picker-row">
      <div class="pilot-picker debug-usb-picker" role="tablist" aria-label="Active USB connection">
        ${chipsHtml}
        ${actionBtnHtml}
      </div>
    </div>
    ${bannerParts.join("")}`;
}
