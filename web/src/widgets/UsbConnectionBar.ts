import { esc } from "../core/format";
import { icons } from "../core/icons";
import { getAppTheme } from "../core/theme";
import { TimerConsole, usbPool } from "../services/timer_console";

export interface UsbConnectionBarOptions {
  activeConsole: TimerConsole;
  showAllPorts: boolean;
  /** When true (`SlapRF (Bluetooth)` mode), labels controls for wireless Bluetooth Hub connections and omits USB-only options. */
  bluetoothMode?: boolean;
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
    : s?.emergencyMode || (!s && !cfg)
      ? "#facc15"
      : isSpoke
        ? "#38bdf8"
        : getAppTheme() === "light"
          ? "#3b82f6"
          : "#d4ff3a";
  const fp = s?.fp || cfg?.fingerprint || "";
  const fpNote = fp ? ` · ${fp}` : "";
  const viaBluetooth = c.transportLabel === "Bluetooth";
  const roleMetaShown = viaBluetooth && !isWriting ? `${roleMeta} · Bluetooth` : roleMeta;
  const closeBtn = canDisconnect
    ? `<button
        type="button"
        class="debug-usb-chip-close"
        data-action="disconnect-usb-slot"
        data-usb-slot="${c.slotIndex}"
        title="${isWriting ? `Cancel writing and disconnect ${esc(label)}` : `Disconnect ${esc(label)}`}"
        aria-label="${isWriting ? `Cancel writing and disconnect ${esc(label)}` : `Disconnect ${esc(label)}`}"
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
        title="${esc(label)} (${esc(roleMetaShown)}${esc(fpNote)})"
      >
        <span class="dot is-live"></span>
        <span class="pilot-chip-name">${esc(label)}</span>
        <span class="pilot-chip-time">${esc(roleMetaShown)}</span>
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
  const bleMode = Boolean(opts.bluetoothMode);
  const main = usbPool.mainConsole;
  const swapSlot = usbPool.slots[1];
  const poolBusy = usbPool.slots.find((c) => c.busyLabel)?.busyLabel ?? null;
  const busyText = opts.busyText || opts.activeConsole.busyLabel || poolBusy || "";
  const busy = busyText.length > 0;

  let chipsHtml = "";
  let actionBtnHtml = "";

  if (opts.allowSwap && !bleMode) {
    // Debug page (USB mode):
    // - Protect only a Hub connection (`canDisconnect = false`); any non-Hub port (Spoke / Other) can be closed.
    // - Allow choosing a second USB connection (Slot 1) to debug on, shown alongside the main connection so the user
    //   can switch between them or close non-Hub connections.
    // - Once both slots are occupied, hide the connect button until a slot is closed.
    const isHubConsole = (c: TimerConsole): boolean =>
      c.lastStatus ? c.lastStatus.role === 1 : c.lastConfig?.role === "hub";
    const chips: string[] = [];
    if (main.connected) {
      chips.push(renderChip(main, opts.activeConsole === main, !isHubConsole(main)));
    }
    if (swapSlot.connected) {
      chips.push(renderChip(swapSlot, opts.activeConsole === swapSlot, !isHubConsole(swapSlot)));
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
    // Network page (and Bluetooth Hub mode on both Network & Debug): single primary connection (Slot 0).
    if (main.connected) {
      chipsHtml = renderChip(main, true, true);
    } else {
      const connectText = bleMode ? "Connect Bluetooth" : "Connect USB";
      const connectTitle = bleMode ? "Connect a SlapRF Bluetooth Hub" : "Connect a USB device";
      actionBtnHtml = `
        <button
          type="button"
          class="pilot-chip debug-usb-add-chip"
          data-action="connect-add"
          ${supported && !busy ? "" : "disabled"}
          title="${connectTitle}"
        >
          ${bleMode ? icons.wifi(20) : icons.plug(20)}
          <span class="pilot-chip-name">${busy ? `${esc(busyText)}…` : connectText}</span>
        </button>`;
    }
  }

  const bannerParts: string[] = [];
  if (!supported) {
    bannerParts.push(
      bleMode
        ? `<div class="sim-error-note">Connect a SlapRF Server or open the mobile app to connect a Bluetooth Hub.</div>`
        : `<div class="sim-error-note">Connect a SlapRF Server to open physical USB serial ports.</div>`
    );
  }
  if (opts.error) {
    bannerParts.push(`<div class="sim-error-note">${esc(opts.error)}</div>`);
  }

  return `
    <div class="picker-row debug-usb-picker-row">
      <div class="pilot-picker debug-usb-picker" role="tablist" aria-label="${bleMode ? "Active Bluetooth connection" : "Active USB connection"}">
        ${chipsHtml}
        ${actionBtnHtml}
      </div>
    </div>
    ${bannerParts.join("")}`;
}
