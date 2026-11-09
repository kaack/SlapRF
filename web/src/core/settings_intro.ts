/**
 * Collapses `.settings-intro` section descriptions into a single-line snippet
 * with `… (see more)` when sections stack into a single column
 * (`@media (max-width: 1260px)`), expanding to the full description on click.
 */

interface IntroState {
  intro: HTMLElement;
  key: string;
  firstP: HTMLParagraphElement;
  snippetEl: HTMLParagraphElement;
  snippetTextEl: HTMLSpanElement;
  moreBtn: HTMLButtonElement;
  update: () => void;
}

const managedIntros = new WeakMap<HTMLElement, IntroState>();
const expandedKeys = new Set<string>();

function extractParaText(p: HTMLElement): string {
  let raw = "";
  p.childNodes.forEach((node) => {
    if (node instanceof HTMLElement && node.classList.contains("settings-intro-less")) {
      return;
    }
    raw += node.textContent ?? "";
  });
  return raw.replace(/\s+/g, " ").trim();
}

function updateIntro(state: IntroState): void {
  const { snippetTextEl, moreBtn, firstP } = state;
  const firstParaText = extractParaText(firstP);
  if (!firstParaText) {
    moreBtn.hidden = true;
    state.snippetEl.classList.remove("is-clickable");
    return;
  }
  if (snippetTextEl.textContent !== firstParaText) {
    snippetTextEl.textContent = firstParaText;
  }
  moreBtn.hidden = false;
  const overflowsWithBtn = snippetTextEl.scrollWidth > snippetTextEl.clientWidth + 1;
  if (!overflowsWithBtn) {
    snippetTextEl.textContent = `${firstParaText}…`;
  }
  state.snippetEl.classList.add("is-clickable");
}

function enhanceIntro(intro: HTMLElement, ro: ResizeObserver): void {
  if (managedIntros.has(intro)) {
    managedIntros.get(intro)!.update();
    return;
  }

  const ps = Array.from(intro.querySelectorAll<HTMLParagraphElement>(":scope > p"));
  if (ps.length === 0) return;

  const headingText = (intro.querySelector("h2, h3")?.textContent ?? "").replace(/\s+/g, " ").trim();
  const key = headingText || (ps[0].textContent ?? "").slice(0, 40);

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
    if (key) expandedKeys.delete(key);
    state.update();
  });
  lastP.appendChild(document.createTextNode(" "));
  lastP.appendChild(lessBtn);

  const snippetEl = document.createElement("p");
  snippetEl.className = "settings-intro-snippet";

  const snippetTextEl = document.createElement("span");
  snippetTextEl.className = "settings-intro-snippet-text";
  snippetTextEl.textContent = extractParaText(ps[0]);

  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "settings-intro-toggle settings-intro-more";
  moreBtn.textContent = "(see more)";

  const expand = (e: Event) => {
    if (moreBtn.hidden) return;
    e.stopPropagation();
    intro.classList.add("is-expanded");
    if (key) expandedKeys.add(key);
  };
  moreBtn.addEventListener("click", expand);
  snippetEl.addEventListener("click", expand);

  snippetEl.appendChild(snippetTextEl);
  snippetEl.appendChild(moreBtn);

  intro.appendChild(snippetEl);
  intro.appendChild(fullWrap);
  intro.classList.add("has-intro-collapse");
  if (key && expandedKeys.has(key)) {
    intro.classList.add("is-expanded");
  }

  const state: IntroState = {
    intro,
    key,
    firstP: ps[0],
    snippetEl,
    snippetTextEl,
    moreBtn,
    update: () => updateIntro(state),
  };

  const textMo = new MutationObserver(() => state.update());
  textMo.observe(ps[0], { childList: true, characterData: true, subtree: true });

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
