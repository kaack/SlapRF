(() => {
  if (window.__slaprfThemeSwitchBound) return;
  window.__slaprfThemeSwitchBound = true;

  const syncSwitchAria = () => {
    const isDark = document.documentElement.classList.contains("dark");
    document.querySelectorAll("[data-doc-theme-switch]").forEach((el) => {
      el.setAttribute("aria-checked", isDark ? "true" : "false");
    });
  };

  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("[data-doc-theme-switch]");
    if (!btn) return;
    e.preventDefault();
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(next);
    document.documentElement.style.colorScheme = next;
    try {
      localStorage.setItem("color-theme", next);
    } catch (_) {}
    syncSwitchAria();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncSwitchAria);
  } else {
    syncSwitchAria();
  }
})();
