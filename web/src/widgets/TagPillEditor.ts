import { esc } from "../core/format";

export function normalizeTagToken(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

export function parseTagTokens(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const clean = normalizeTagToken(part);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export interface RenderTagPillBoxOptions {
  boxId?: string;
  tags: string[];
  placeholder?: string;
  compact?: boolean;
  ariaLabel?: string;
}

function renderTagPillsInner(tags: string[], selectedIdx = -1): string {
  return tags
    .map(
      (t, idx) => `
      <span
        class="slaprf-tag-pill ${selectedIdx === idx ? "is-selected" : ""}"
        data-tag-pill-idx="${idx}"
        data-tag-pill-val="${esc(t)}"
      >
        <span class="slaprf-tag-pill-text">${esc(t)}</span>
        <button
          type="button"
          class="slaprf-tag-pill-rm"
          data-tag-pill-remove="${idx}"
          tabindex="-1"
          title="Remove tag ${esc(t)}"
          aria-label="Remove tag ${esc(t)}"
        >×</button>
      </span>`
    )
    .join("");
}

export function renderTagPillBoxHtml(opts: RenderTagPillBoxOptions): string {
  const {
    boxId = "default",
    tags,
    placeholder = "Type tag and press comma…",
    compact = false,
    ariaLabel = "Edit tags",
  } = opts;
  return `
    <div class="slaprf-tag-box ${compact ? "is-compact" : ""}" data-tag-box="${esc(boxId)}">
      <span class="slaprf-tag-pill-list" data-tag-pill-list>${renderTagPillsInner(tags)}</span>
      <input
        type="text"
        class="slaprf-tag-box-input"
        data-tag-box-input="${esc(boxId)}"
        placeholder="${tags.length === 0 ? esc(placeholder) : ""}"
        maxlength="64"
        autocomplete="off"
        aria-label="${esc(ariaLabel)}"
      />
    </div>`;
}

export interface MountTagPillEditorOptions {
  initialTags: string[];
  placeholder?: string;
  autoFocus?: boolean;
  onChange?: (tags: string[]) => void;
  onCommit?: (tags: string[]) => void;
  onCancel?: () => void;
}

export interface TagPillEditorHandle {
  getTags: () => string[];
  addTag: (raw: string) => boolean;
  flushPending: () => boolean;
  focus: () => void;
}

export function mountTagPillEditor(
  boxEl: HTMLElement,
  opts: MountTagPillEditorOptions
): TagPillEditorHandle {
  const pillListEl = boxEl.querySelector<HTMLElement>("[data-tag-pill-list]");
  const inputEl = boxEl.querySelector<HTMLInputElement>("[data-tag-box-input]");
  const placeholder = opts.placeholder ?? "Type tag and press comma…";

  const tags: string[] = [];
  const seenInit = new Set<string>();
  for (const t of opts.initialTags) {
    const clean = normalizeTagToken(t);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seenInit.has(key)) continue;
    seenInit.add(key);
    tags.push(clean);
  }

  let selectedIdx = -1;
  let finished = false;

  const syncInputDynamicWidth = (): void => {
    if (!inputEl) return;
    if (tags.length === 0 && !inputEl.value) {
      inputEl.style.removeProperty("--tag-input-w");
      return;
    }
    const charLen = inputEl.value.length;
    const neededPx = Math.max(76, Math.ceil((charLen + 2) * 7.6));
    inputEl.style.setProperty("--tag-input-w", `${neededPx}px`);
  };

  const scrollActiveIntoView = (): void => {
    if (!boxEl.isConnected) return;
    if (selectedIdx >= 0) {
      const selEl = boxEl.querySelector<HTMLElement>(`[data-tag-pill-idx="${selectedIdx}"]`);
      if (selEl) {
        const boxLeft = boxEl.scrollLeft;
        const boxRight = boxLeft + boxEl.clientWidth;
        const elLeft = selEl.offsetLeft - 6;
        const elRight = selEl.offsetLeft + selEl.offsetWidth + 6;
        if (elLeft < boxLeft) {
          boxEl.scrollLeft = Math.max(0, elLeft);
        } else if (elRight > boxRight) {
          boxEl.scrollLeft = elRight - boxEl.clientWidth;
        }
        return;
      }
    }
    boxEl.scrollLeft = boxEl.scrollWidth;
  };

  const scheduleScrollSync = (): void => {
    syncInputDynamicWidth();
    scrollActiveIntoView();
    requestAnimationFrame(() => {
      if (!finished && boxEl.isConnected) {
        syncInputDynamicWidth();
        scrollActiveIntoView();
      }
    });
  };

  const syncDom = (notify = true): void => {
    if (selectedIdx >= tags.length) {
      selectedIdx = -1;
    }
    if (pillListEl) {
      pillListEl.innerHTML = renderTagPillsInner(tags, selectedIdx);
    }
    if (inputEl) {
      inputEl.placeholder = tags.length === 0 ? placeholder : "";
    }
    scheduleScrollSync();
    if (notify) {
      opts.onChange?.([...tags]);
    }
  };

  const appendTokens = (tokens: string[]): boolean => {
    let added = false;
    const seen = new Set(tags.map((t) => t.toLowerCase()));
    for (const raw of tokens) {
      const clean = normalizeTagToken(raw);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(clean);
      added = true;
    }
    if (added) {
      selectedIdx = -1;
      syncDom(true);
    }
    return added;
  };

  const flushPending = (): boolean => {
    if (!inputEl) return false;
    const raw = inputEl.value;
    if (!raw.trim()) {
      inputEl.value = "";
      return false;
    }
    const parsed = parseTagTokens(raw);
    inputEl.value = "";
    return appendTokens(parsed);
  };

  syncDom(false);

  boxEl.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target !== inputEl) {
      // Keep focus anchored inside inputEl when clicking pills, × buttons, or empty padding
      e.preventDefault();
      inputEl?.focus();
    }
  });

  boxEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const rmBtn = target.closest<HTMLElement>("[data-tag-pill-remove]");
    if (rmBtn) {
      const idx = Number(rmBtn.dataset.tagPillRemove);
      if (Number.isInteger(idx) && idx >= 0 && idx < tags.length) {
        tags.splice(idx, 1);
        selectedIdx = -1;
        syncDom(true);
      }
      inputEl?.focus();
      return;
    }

    const pillEl = target.closest<HTMLElement>("[data-tag-pill-idx]");
    if (pillEl) {
      const idx = Number(pillEl.dataset.tagPillIdx);
      if (Number.isInteger(idx) && idx >= 0 && idx < tags.length) {
        selectedIdx = selectedIdx === idx ? -1 : idx;
        syncDom(false);
      }
      inputEl?.focus();
      return;
    }

    if (selectedIdx !== -1) {
      selectedIdx = -1;
      syncDom(false);
    }
    inputEl?.focus();
  });

  boxEl.addEventListener(
    "wheel",
    (e) => {
      if (boxEl.scrollWidth <= boxEl.clientWidth) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta !== 0) {
        e.preventDefault();
        boxEl.scrollLeft += delta;
      }
    },
    { passive: false }
  );

  inputEl?.addEventListener("focus", () => {
    scheduleScrollSync();
  });

  inputEl?.addEventListener("input", () => {
    if (selectedIdx !== -1) {
      selectedIdx = -1;
      syncDom(false);
    }
    const val = inputEl.value;
    if (!val.includes(",")) {
      scheduleScrollSync();
      return;
    }
    const parts = val.split(",");
    const trailing = parts.pop() ?? "";
    inputEl.value = trailing.replace(/^\s+/, "");
    if (!appendTokens(parts)) {
      scheduleScrollSync();
    }
  });

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === ",") {
      e.preventDefault();
      flushPending();
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      const atStartEmpty =
        inputEl.value === "" ||
        (e.key === "Backspace" &&
          inputEl.selectionStart === 0 &&
          inputEl.selectionEnd === 0 &&
          selectedIdx !== -1);

      if (selectedIdx >= 0 && selectedIdx < tags.length && (inputEl.value === "" || atStartEmpty)) {
        e.preventDefault();
        tags.splice(selectedIdx, 1);
        selectedIdx = -1;
        syncDom(true);
        return;
      }

      if (e.key === "Backspace" && inputEl.value === "" && tags.length > 0) {
        e.preventDefault();
        tags.pop();
        selectedIdx = -1;
        syncDom(true);
        return;
      }
    }

    if (e.key === "ArrowLeft" && inputEl.value === "" && tags.length > 0) {
      e.preventDefault();
      selectedIdx = selectedIdx <= 0 ? tags.length - 1 : selectedIdx - 1;
      syncDom(false);
      return;
    }

    if (e.key === "ArrowRight" && inputEl.value === "" && selectedIdx !== -1) {
      e.preventDefault();
      selectedIdx = selectedIdx >= tags.length - 1 ? -1 : selectedIdx + 1;
      syncDom(false);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (inputEl.value.trim()) {
        flushPending();
        return;
      }
      if (opts.onCommit && !finished) {
        finished = true;
        opts.onCommit([...tags]);
      }
      return;
    }

    if (e.key === "Escape") {
      if (selectedIdx !== -1) {
        e.preventDefault();
        e.stopPropagation();
        selectedIdx = -1;
        syncDom(false);
        return;
      }
      if (opts.onCancel && !finished) {
        e.preventDefault();
        e.stopPropagation();
        finished = true;
        opts.onCancel();
      }
    }
  });

  boxEl.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (finished || !boxEl.isConnected) return;
      if (boxEl.contains(document.activeElement)) return;
      flushPending();
      if (opts.onCommit && !finished) {
        finished = true;
        opts.onCommit([...tags]);
      }
    }, 0);
  });

  if (opts.autoFocus) {
    requestAnimationFrame(() => {
      if (!finished && inputEl?.isConnected) {
        inputEl.focus();
      }
    });
  }

  return {
    getTags: () => [...tags],
    addTag: (raw: string) => {
      const ok = appendTokens([raw]);
      inputEl?.focus();
      return ok;
    },
    flushPending,
    focus: () => inputEl?.focus(),
  };
}
