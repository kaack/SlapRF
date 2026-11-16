import { esc } from "../core/format";
import { icons } from "../core/icons";

export interface ConfirmModalOptions {
  title: string;
  messageHtml: string;
  warningHtml?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

let activeModalCleanup: (() => void) | null = null;

/**
 * Opens an accessible, keyboard-friendly confirmation modal appended to `document.body`.
 * Uses restrained neutral styling (no red delete buttons or neon fills).
 */
export function openConfirmModal(opts: ConfirmModalOptions): void {
  if (activeModalCleanup) {
    activeModalCleanup();
  }

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", opts.title);

  const confirmLabel = opts.confirmLabel ?? "Confirm";
  const cancelLabel = opts.cancelLabel ?? "Cancel";

  backdrop.innerHTML = `
    <div class="slaprf-modal card" role="document">
      <div class="slaprf-modal-head">
        <div class="slaprf-modal-title-row">
          <span class="slaprf-modal-icon">
            ${icons.alertTriangle(17)}
          </span>
          <h3>${esc(opts.title)}</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-modal-cancel aria-label="Close">
          ${icons.close(15)}
        </button>
      </div>
      <div class="slaprf-modal-body">
        <div class="slaprf-modal-msg">${opts.messageHtml}</div>
        ${opts.warningHtml ? `<div class="slaprf-modal-warn">${opts.warningHtml}</div>` : ""}
      </div>
      <div class="slaprf-modal-foot">
        <button type="button" class="btn btn-ghost" data-modal-cancel>${esc(cancelLabel)}</button>
        <button type="button" class="btn btn-armed ${opts.danger ? "is-danger" : ""}" data-modal-confirm>
          ${icons.check(15)}
          <span>${esc(confirmLabel)}</span>
        </button>
      </div>
    </div>
  `;

  const cleanup = (): void => {
    window.removeEventListener("keydown", onKeyDown, true);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activeModalCleanup === cleanup) {
      activeModalCleanup = null;
    }
  };
  activeModalCleanup = cleanup;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t === backdrop || t.closest("[data-modal-cancel]")) {
      cleanup();
      return;
    }
    const confirmBtn = t.closest<HTMLButtonElement>("[data-modal-confirm]");
    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.disabled = true;
      Promise.resolve(opts.onConfirm())
        .catch(() => undefined)
        .finally(() => cleanup());
    }
  });

  document.body.appendChild(backdrop);
  const focusTarget = backdrop.querySelector<HTMLButtonElement>(
    opts.danger ? "[data-modal-cancel]" : "[data-modal-confirm]"
  );
  focusTarget?.focus();
}
