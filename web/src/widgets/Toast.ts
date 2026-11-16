import { esc } from "../core/format";
import { icons } from "../core/icons";
import { RaceTournamentState, RoundConnection, StageConnection } from "../types/models";

export type ToastTone = "error" | "warn" | "info" | "success";

export interface ToastOptions {
  title?: string;
  durationMs?: number;
}

interface ActiveToastEntry {
  el: HTMLElement;
  timer: number;
  key: string;
}

const activeToasts = new Map<string, ActiveToastEntry>();

function ensureToasterRoot(): HTMLElement {
  let root = document.querySelector<HTMLElement>(".slaprf-toaster");
  if (!root) {
    root = document.createElement("div");
    root.className = "slaprf-toaster";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Notifications");
    document.body.appendChild(root);
  }
  return root;
}

export function cleanConnectionInvalidReason(reason?: string): string {
  if (!reason) return "This connection is invalid and needs attention.";
  const stripped = reason
    .replace(/^Error:\s*/i, "")
    .replace(/^(?:WASM|HTTP)\s+[A-Z]+\s+\S+\s+failed\s*\(\d+\):\s*/i, "")
    .replace(/^HTTP\s+\d+:\s*/i, "")
    .replace(/^Started round:\s*/i, "")
    .trim();
  if (!stripped) return "";
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function showToast(
  message: string,
  tone: ToastTone = "error",
  opts: ToastOptions = {}
): void {
  const cleanMsg = cleanConnectionInvalidReason(message);
  if (!cleanMsg) return;

  const root = ensureToasterRoot();
  const title =
    opts.title ??
    (tone === "error"
      ? "Action Needed"
      : tone === "warn"
        ? "Warning"
        : tone === "success"
          ? "Done"
          : "Notice");
  const durationMs = opts.durationMs ?? (tone === "error" ? 6200 : 4500);
  const key = `${tone}:${title}:${cleanMsg}`;

  const dismiss = (entryKey: string): void => {
    const existing = activeToasts.get(entryKey);
    if (!existing) return;
    window.clearTimeout(existing.timer);
    activeToasts.delete(entryKey);
    existing.el.classList.add("is-leaving");
    window.setTimeout(() => {
      existing.el.remove();
    }, 180);
  };

  const dup = activeToasts.get(key);
  if (dup) {
    window.clearTimeout(dup.timer);
    dup.el.classList.remove("is-pulsing");
    void dup.el.offsetWidth;
    dup.el.classList.add("is-pulsing");
    dup.timer = window.setTimeout(() => dismiss(key), durationMs);
    return;
  }

  // Cap visible stack to 4 items
  if (activeToasts.size >= 4) {
    const oldestKey = activeToasts.keys().next().value as string | undefined;
    if (oldestKey) dismiss(oldestKey);
  }

  const toastEl = document.createElement("div");
  toastEl.className = `slaprf-toast tone-${tone}`;
  toastEl.setAttribute("role", tone === "error" ? "alert" : "status");

  const iconSvg =
    tone === "success" ? icons.check(16) : tone === "info" ? icons.link(16) : icons.siren(16);

  toastEl.innerHTML = `
    <span class="slaprf-toast-icon">${iconSvg}</span>
    <div class="slaprf-toast-body">
      <div class="slaprf-toast-title">${esc(title)}</div>
      <div class="slaprf-toast-msg">${esc(cleanMsg)}</div>
    </div>
    <button type="button" class="slaprf-toast-close" aria-label="Dismiss notification">
      ${icons.close(13)}
    </button>
  `;

  toastEl
    .querySelector<HTMLButtonElement>(".slaprf-toast-close")
    ?.addEventListener("click", () => dismiss(key));

  root.appendChild(toastEl);
  const timer = window.setTimeout(() => dismiss(key), durationMs);
  activeToasts.set(key, { el: toastEl, timer, key });
}

/**
 * Checks if any connection in `nextRace` newly became invalid (or changed its invalid reason)
 * compared to `prevConnections`, and surfaces a clear toast notification when so.
 */
export function notifyNewlyInvalidConnections(
  prevConnections: RoundConnection[] | undefined,
  nextRace: RaceTournamentState | undefined | null,
  touchedConnectionId?: string
): void {
  if (!nextRace) return;
  const prevInvalidById = new Map<string, string>();
  for (const c of prevConnections ?? []) {
    if (c.invalid) {
      prevInvalidById.set(c.id, c.invalidReason ?? "invalid");
    }
  }
  for (const c of nextRace.connections ?? []) {
    if (!c.invalid) continue;
    const prevReason = prevInvalidById.get(c.id);
    if (c.id === touchedConnectionId || !prevReason || prevReason !== (c.invalidReason ?? "invalid")) {
      showToast(cleanConnectionInvalidReason(c.invalidReason), "error", {
        title: "Invalid Connection",
      });
    }
  }
}

export function notifyNewlyInvalidStageConnections(
  prevConnections: StageConnection[] | undefined,
  nextRace: RaceTournamentState | undefined | null,
  touchedConnectionId?: string
): void {
  if (!nextRace) return;
  const prevInvalidById = new Map<string, string>();
  for (const c of prevConnections ?? []) {
    if (c.invalid) {
      prevInvalidById.set(c.id, c.invalidReason ?? "invalid");
    }
  }
  for (const c of nextRace.stageConnections ?? []) {
    if (!c.invalid) continue;
    const prevReason = prevInvalidById.get(c.id);
    if (c.id === touchedConnectionId || !prevReason || prevReason !== (c.invalidReason ?? "invalid")) {
      showToast(cleanConnectionInvalidReason(c.invalidReason), "error", {
        title: "Invalid Stage Connection",
      });
    }
  }
}
