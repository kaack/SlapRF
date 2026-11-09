/**
 * Collapses multi-line `.settings-intro` descriptions into a single-line snippet
 * with `… (see more)` when `.settings-section` stacks into a single column
 * (`@media (max-width: 1260px)`), expanding to the full description on click.
 */

interface IntroState {
  intro: HTMLElement;
  snippetEl: HTMLParagraphElement;
  snippetTextEl: HTMLSpanElement;
  moreBtn: HTMLButtonElement;
  hasMultipleParagraphs: boolean;
  firstParaText: string;
  update: () => void;
}

const managedIntros = new WeakMap<HTMLElement, IntroState>();

function updateIntro(state: IntroState): void {
  const { snippetTextEl, moreBtn, hasMultipleParagraphs, firstParaText } = state;
  if (snippetTextEl.textContent !== firstParaText) {
    snippetTextEl.textContent = firstParaText;
  }
  if (hasMultipleParagraphs) {
    moreBtn.hidden = false;
    const overflowsWithBtn = snippetTextEl.scrollWidth > snippetTextEl.clientWidth + 1;
    if (!overflowsWithBtn) {
      snippetTextEl.textContent = `${firstParaText}…`;
    }
    state.snippetEl.classList.add("is-clickable");
    return;
  }
  moreBtn.hidden = true;
  const overflowsLine = snippetTextEl.scrollWidth > snippetTextEl.clientWidth + 1;
  moreBtn.hidden = !overflowsLine;
  state.snippetEl.classList.toggle("is-clickable", overflowsLine);
}

function enhanceIntro(intro: HTMLElement, ro: ResizeObserver): void {
  if (managedIntros.has(intro)) {
    managedIntros.get(intro)!.update();
    return;
  }

  const ps = Array.from(intro.querySelectorAll<HTMLParagraphElement>(":scope > p"));
  if (ps.length === 0) return;

  const firstParaText = (ps[0].textContent ?? "").replace(/\s+/g, " ").trim();
  if (!firstParaText) return;

  const hasMultipleParagraphs = ps.length > 1;

  const fullWrap = document.createElement("div");
  fullWrap.className = "settings-intro-full";
  for (const p of ps) {
    fullWrap.appendChild(p);
  }

  const lastP = ps[ps.length - 1];
  const lessBtn = document.createElement("button");
  lessBtn.type = "button";
  lessBtn.className = "settings-intro-toggle settings-intro-less";
  lessBtn.textContent = "(see less)";
  lessBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    intro.classList.remove("is-expanded");
    state.update();
  });
  lastP.appendChild(document.createTextNode(" "));
  lastP.appendChild(lessBtn);

  const snippetEl = document.createElement("p");
  snippetEl.className = "settings-intro-snippet";

  const snippetTextEl = document.createElement("span");
  snippetTextEl.className = "settings-intro-snippet-text";
  snippetTextEl.textContent = firstParaText;

  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "settings-intro-toggle settings-intro-more";
  moreBtn.textContent = "(see more)";

  const expand = (e: Event) => {
    if (moreBtn.hidden) return;
    e.stopPropagation();
    intro.classList.add("is-expanded");
  };
  moreBtn.addEventListener("click", expand);
  snippetEl.addEventListener("click", expand);

  snippetEl.appendChild(snippetTextEl);
  snippetEl.appendChild(moreBtn);

  intro.appendChild(snippetEl);
  intro.appendChild(fullWrap);
  intro.classList.add("has-intro-collapse");

  const state: IntroState = {
    intro,
    snippetEl,
    snippetTextEl,
    moreBtn,
    hasMultipleParagraphs,
    firstParaText,
    update: () => updateIntro(state),
  };

  managedIntros.set(intro, state);
  ro.observe(intro);
  requestAnimationFrame(() => state.update());
}

export function installSettingsIntroCollapse(): void {
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const state = managedIntros.get(el);
      if (state) state.update();
    }
  });

  const scan = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.matches(".settings-intro")) {
      enhanceIntro(root, ro);
    }
    root.querySelectorAll<HTMLElement>(".settings-intro").forEach((el) => {
      enhanceIntro(el, ro);
    });
  };

  scan(document);

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          scan(node);
        }
      });
    }
  });

  mo.observe(document.body, { childList: true, subtree: true });
}
