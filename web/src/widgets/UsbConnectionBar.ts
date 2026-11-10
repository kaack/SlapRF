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

function renderChip(c: TimerConsole, active: boolean, canDisconnect = true): string {
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
  const closeBtn = canDisconnect
    ? `<button
        type="button"
        class="debug-usb-chip-close"
        data-action="disconnect-usb-slot"
        data-usb-slot="${c.slotIndex}"
        ${isWriting ? "disabled" : ""}
        title="Disconnect ${esc(label)}"
        aria-label="Disconnect ${esc(label)}"
      >${icons.close(13)}</button>`
    : "";
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
      ${closeBtn}
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
    // Debug page:
    // - Never allow disconnecting the main/Hub USB connection (Slot 0) from the Debug window (`canDisconnect = false`).
    // - Allow choosing a second USB connection (Slot 1) to debug on, shown alongside the main connection so the user
    //   can switch between them or close the secondary debug USB connection (`canDisconnect = true`).
    // - Once a secondary debug USB connection is active, hide the connect button until the user disconnects it.
    const chips: string[] = [];
    if (main.connected) {
      chips.push(renderChip(main, opts.activeConsole === main, false));
    }
    if (swapSlot.connected) {
      chips.push(renderChip(swapSlot, opts.activeConsole === swapSlot, true));
    }
    chipsHtml = chips.join("");

    if (!swapSlot.connected) {
      const mainLabel =
        main.lastStatus?.label || main.lastConfig?.timerLabel || (main.lastStatus?.role === 1 ? "H1" : "Main USB");
      const btnLabel = busy ? `${esc(busyText)}…` : main.connected ? "Debug another USB" : "Connect USB";
      const btnTitle = main.connected
        ? `Choose a different USB device to debug while keeping ${esc(mainLabel)} connected`
        : "Connect a USB device";
      actionBtnHtml = `
        <button
          type="button"
          class="pilot-chip debug-usb-add-chip"
          data-action="connect-add"
          ${supported && !busy ? "" : "disabled"}
          title="${btnTitle}"
        >
          ${icons.plug(20)}
          <span class="pilot-chip-name">${btnLabel}</span>
        </button>`;
    }
  } else {
    // Network & Flasher pages: strictly single main USB connection (Slot 0).
    if (main.connected) {
      chipsHtml = renderChip(main, true, true);
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
