(() => {
  if (window.__slaprfThemeSwitchBound) return;
  window.__slaprfThemeSwitchBound = true;

  const getStoredMode = () => {
    try {
      const stored = localStorage.getItem("color-theme");
      if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
      }
    } catch (_) {}
    return "system";
  };

  const resolveTheme = (mode) => {
    if (mode === "light" || mode === "dark") return mode;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  const syncSwitchState = (mode) => {
    document.documentElement.dataset.docThemeMode = mode;
    document.querySelectorAll("[data-doc-theme-option]").forEach((el) => {
      const opt = el.getAttribute("data-doc-theme-option");
      el.setAttribute("aria-checked", opt === mode ? "true" : "false");
    });
  };

  const applyMode = (mode, persist) => {
    const resolved = resolveTheme(mode);
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(resolved);
    document.documentElement.style.colorScheme = resolved;
    if (persist) {
      try {
        localStorage.setItem("color-theme", mode);
      } catch (_) {}
    }
    syncSwitchState(mode);
  };

  document.addEventListener("click", (e) => {
    const btn =
      e.target &&
      e.target.closest &&
      e.target.closest("[data-doc-theme-option]");
    if (!btn) return;
    e.preventDefault();
    const next = btn.getAttribute("data-doc-theme-option") || "system";
    applyMode(next, true);
  });

  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => {
      if (getStoredMode() === "system") {
        applyMode("system", false);
      }
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onMediaChange);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(onMediaChange);
    }
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.update().catch(() => {})))
      .catch(() => {});
  }

  const init = () => applyMode(getStoredMode(), false);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
