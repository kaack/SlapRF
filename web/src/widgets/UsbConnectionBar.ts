import { esc } from "../core/format";
import { icons } from "../core/icons";
import { getAppTheme } from "../core/theme";
import { getPairedBluetoothHub, TimerConsole, usbPool } from "../services/timer_console";

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

function renderChip(c: TimerConsole, active: boolean, canManage = true): string {
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
  const openMenuOnClick = canManage && active && !isWriting;
  const actionAttr = openMenuOnClick ? "open-usb-slot-actions" : "select-usb-slot";
  const titleText = openMenuOnClick
    ? `${label} (${roleMetaShown}${fpNote}) · click for connection options`
    : `${label} (${roleMetaShown}${fpNote})`;
  const caretHtml = openMenuOnClick
    ? `<span class="debug-usb-chip-caret" aria-hidden="true">${icons.chevronDown(13)}</span>`
    : "";
  return `
    <div class="pilot-chip debug-usb-chip ${active ? "is-active" : ""} ${isWriting ? "is-writing" : ""}" style="--c:${chipColor}">
      <button
        type="button"
        class="debug-usb-chip-select ${openMenuOnClick ? "has-menu-caret" : ""}"
        role="tab"
        aria-selected="${active}"
        ${openMenuOnClick ? 'aria-haspopup="dialog"' : ""}
        data-action="${actionAttr}"
        data-usb-slot="${c.slotIndex}"
        title="${esc(titleText)}"
      >
        <span class="dot is-live"></span>
        <span class="pilot-chip-name">${esc(label)}</span>
        <span class="pilot-chip-time">${esc(roleMetaShown)}</span>
        ${caretHtml}
      </button>
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
  const connectingState = !main.connected && (main.connecting || opts.activeConsole.connecting);
  const reconnectingState = !main.connected && main.reconnecting;
  const fallbackBusy = reconnectingState ? "Reconnecting" : connectingState ? "Connecting" : "";
  const busyText = opts.busyText || opts.activeConsole.busyLabel || poolBusy || fallbackBusy;
  const busy = busyText.length > 0;
  const isConnectingFlow = !main.connected && (busy || connectingState || reconnectingState);
  const liveConnectStatus =
    opts.activeConsole.connectStatus ||
    main.connectStatus ||
    (reconnectingState
      ? main.reconnectAttempt > 0
        ? `Reconnecting (attempt ${main.reconnectAttempt} of ${main.maxReconnectAttempts})…`
        : "Reconnecting…"
      : bleMode
        ? "Waiting for Bluetooth LE connection…"
        : "Waiting for connection…");

  let chipsHtml = "";
  let actionBtnHtml = "";
  let cancelBtnHtml = "";

  if (opts.allowSwap && !bleMode) {
    // Debug page (USB mode):
    // - Protect only a Hub connection (`canManage = false`); any active non-Hub port (Spoke / Other) opens Disconnect options on click.
    // - Allow choosing a second USB connection (Slot 1) to debug on, shown alongside the main connection so the user
    //   can switch between them.
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
      if (isConnectingFlow) {
        cancelBtnHtml = `
          <button
            type="button"
            class="pilot-chip debug-usb-cancel-chip"
            data-action="cancel-connect"
            title="Cancel connection attempt"
          >
            <span class="pilot-chip-name">Cancel</span>
          </button>`;
      }
    }
  } else {
    // Network page (and Bluetooth Hub mode on both Network & Debug): single primary connection (Slot 0).
    // Clicking the connected pill opens the Disconnect / Forget Device modal (desktop) or drawer (mobile).
    const pairedBleHub = bleMode ? getPairedBluetoothHub() : null;
    if (main.connected) {
      chipsHtml = renderChip(main, true, true);
    } else {
      const connectText = bleMode ? (pairedBleHub ? "Connect" : "Pair Device") : "Connect USB";
      const connectTitle = bleMode
        ? pairedBleHub
          ? `Connect to paired Bluetooth Hub ${pairedBleHub.label} (${pairedBleHub.fp})`
          : "Pair a SlapRF Bluetooth Hub"
        : "Connect a USB device";
      actionBtnHtml = `
        <button
          type="button"
          class="pilot-chip debug-usb-add-chip"
          data-action="connect-add"
          ${supported && !busy ? "" : "disabled"}
          title="${esc(connectTitle)}"
        >
          ${bleMode ? icons.wifi(20) : icons.plug(20)}
          <span class="pilot-chip-name">${busy ? `${esc(busyText)}…` : connectText}</span>
        </button>`;
      if (isConnectingFlow) {
        cancelBtnHtml = `
          <button
            type="button"
            class="pilot-chip debug-usb-cancel-chip"
            data-action="cancel-connect"
            title="Cancel connection attempt"
          >
            <span class="pilot-chip-name">Cancel</span>
          </button>`;
      }
    }
  }

  const bannerParts: string[] = [];
  if (isConnectingFlow) {
    bannerParts.push(
      `<div class="debug-usb-busy-wrap">
        <div class="slaprf-indeterminate-track" role="progressbar" aria-label="${esc(busyText)}">
          <div class="slaprf-indeterminate-bar"></div>
        </div>
        <div class="debug-usb-busy-status" role="status" aria-live="polite">${esc(liveConnectStatus)}</div>
      </div>`
    );
  }
  if (!supported) {
    bannerParts.push(
      bleMode
        ? `<div class="sim-error-note">Connect a SlapRF Server or open the mobile app to connect a Bluetooth Hub.</div>`
        : `<div class="sim-error-note">Connect a SlapRF Server to open physical USB serial ports.</div>`
    );
  }
  if (opts.error && !isConnectingFlow) {
    bannerParts.push(`<div class="sim-error-note">${esc(opts.error)}</div>`);
  }

  return `
    <div class="picker-row debug-usb-picker-row">
      <div class="pilot-picker debug-usb-picker" role="tablist" aria-label="${bleMode ? "Active Bluetooth connection" : "Active USB connection"}">
        ${chipsHtml}
        ${actionBtnHtml}
        ${cancelBtnHtml}
      </div>
    </div>
    ${bannerParts.join("")}`;
}
