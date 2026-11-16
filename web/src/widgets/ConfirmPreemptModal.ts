import { esc } from "../core/format";
import { icons } from "../core/icons";

let activePreemptModalClose: (() => void) | null = null;

export interface PreemptPromptOptions {
  title: string;
  bodyHtml: string;
  okLabel?: string;
  onConfirm: () => void;
}

/**
 * Displays a confirmation modal when starting/resuming a Race or Practice session
 * would automatically pause another ongoing Race or active Practice session.
 */
export function openConfirmPreemptModal(opts: PreemptPromptOptions): void {
  if (activePreemptModalClose) {
    activePreemptModalClose();
  }

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", opts.title);

  const okLabel = opts.okLabel || "Continue";

  backdrop.innerHTML = `
    <div class="slaprf-modal card" role="document">
      <div class="slaprf-modal-head">
        <div class="slaprf-modal-title-row">
          <span class="slaprf-modal-icon">${icons.alertTriangle(17)}</span>
          <h3>${esc(opts.title)}</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-preempt-cancel aria-label="Close">
          ${icons.close(15)}
        </button>
      </div>
      <div class="slaprf-modal-body">
        <div class="slaprf-modal-msg">${opts.bodyHtml}</div>
      </div>
      <div class="slaprf-modal-foot">
        <button type="button" class="btn btn-ghost" data-preempt-cancel>Cancel</button>
        <button type="button" class="btn btn-armed" data-preempt-ok>
          ${icons.check(15)}
          <span>${esc(okLabel)}</span>
        </button>
      </div>
    </div>
  `;

  const close = (): void => {
    window.removeEventListener("keydown", onKeyDown, true);
    backdrop.removeEventListener("click", onClick);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activePreemptModalClose === close) {
      activePreemptModalClose = null;
    }
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-preempt-cancel]")) {
      close();
      return;
    }
    if (target.closest("[data-preempt-ok]")) {
      close();
      opts.onConfirm();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      close();
      opts.onConfirm();
    }
  };

  activePreemptModalClose = close;
  backdrop.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown, true);
  document.body.appendChild(backdrop);
  const okBtn = backdrop.querySelector<HTMLButtonElement>("[data-preempt-ok]");
  okBtn?.focus();
}
