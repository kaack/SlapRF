import { esc } from "../core/format";
import { icons } from "../core/icons";
import { MAX_USB_CONNECTIONS, TimerConsole, usbPool } from "../services/timer_console";

export interface UsbConnectionBarOptions {
  activeConsole: TimerConsole;
  showAllPorts: boolean;
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

/**
 * Renders the right-hand column of the 2-column "Connection" `<section class="settings-section">`
 * shared across Network, Flasher, and Debug pages.
 */
export function renderUsbConnectionBarHtml(opts: UsbConnectionBarOptions): string {
  const supported = TimerConsole.supported();
  const poolBusy = usbPool.slots.find((c) => c.busyLabel)?.busyLabel ?? null;
  const busyText = opts.busyText || opts.activeConsole.busyLabel || poolBusy || "";
  const busy = busyText.length > 0;
  const connected = usbPool.connectedConsoles();

  const chipsHtml = connected
    .map((c) => {
      const s = c.lastStatus;
      const cfg = c.lastConfig;
      const active = c === opts.activeConsole;
      const isOther = c.isOtherDevice;
      const isWriting = c.writing;
      const isSpoke = s ? s.role === 2 : cfg?.role === "spoke";
      const label = isOther
        ? "Other"
        : s?.label || cfg?.timerLabel || (s?.role === 1 || cfg?.role === "hub" ? "H1" : `USB ${c.slotIndex + 1}`);
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
              ? `USB ${c.slotIndex + 1}`
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
            title="Switch to ${esc(label)} (${esc(roleMeta)}${esc(fpNote)})"
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
    })
    .join("");

  const canAdd = connected.length < MAX_USB_CONNECTIONS;
  const addBtnHtml = canAdd
    ? `<button
        type="button"
        class="pilot-chip debug-usb-add-chip"
        data-action="connect-add"
        ${supported && !busy ? "" : "disabled"}
        title="Connect ${connected.length > 0 ? "another " : ""}USB device (${connected.length}/${MAX_USB_CONNECTIONS} active)"
      >
        ${icons.plug(20)}
        <span class="pilot-chip-name">${busy ? `${esc(busyText)}…` : connected.length > 0 ? "+ Connect USB" : "Connect USB"}</span>
        <span class="pilot-chip-time">${connected.length}/${MAX_USB_CONNECTIONS}</span>
      </button>`
    : "";

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
        ${addBtnHtml}
      </div>
      ${
        !canAdd
          ? `<div class="debug-connect-actions"><span class="note">${MAX_USB_CONNECTIONS}/${MAX_USB_CONNECTIONS} USB connections active</span></div>`
          : ""
      }
    </div>
    ${bannerParts.join("")}`;
}
