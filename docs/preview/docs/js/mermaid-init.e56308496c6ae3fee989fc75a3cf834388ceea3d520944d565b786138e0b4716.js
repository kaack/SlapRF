document.addEventListener("DOMContentLoaded", () => {
  let modalEl = null;

  function getMermaidModal() {
    if (modalEl) return modalEl;
    const tpl = document.getElementById("doc-mermaid-modal-template");
    if (!tpl) return null;
    modalEl = tpl.content.firstElementChild.cloneNode(true);
    document.body.appendChild(modalEl);

    modalEl.addEventListener("click", (e) => {
      const target = e.target;
      if (target === modalEl || (target.closest && target.closest("[data-mermaid-close]"))) {
        closeMermaidModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modalEl && modalEl.dataset.open === "true") {
        e.preventDefault();
        closeMermaidModal();
      }
    });
    return modalEl;
  }

  function openMermaidModal(sourceContainer) {
    const svg = sourceContainer.querySelector("svg");
    if (!svg) return;
    const modal = getMermaidModal();
    if (!modal) return;
    const body = modal.querySelector(".doc-mermaid-modal-body");
    body.innerHTML = "";
    const clone = svg.cloneNode(true);
    clone.removeAttribute("style");
    clone.setAttribute("width", "100%");
    clone.removeAttribute("height");
    body.appendChild(clone);
    modal.dataset.open = "true";
  }

  function closeMermaidModal() {
    if (!modalEl) return;
    modalEl.dataset.open = "false";
  }

  const expandBtnTpl = document.getElementById("doc-mermaid-expand-btn-template");

  document.querySelectorAll(".mermaid").forEach((el) => {
    el.dataset.original = el.innerHTML;
    if (!el.parentElement || !el.parentElement.classList.contains("doc-mermaid-frame")) {
      const frame = document.createElement("div");
      frame.className = "doc-mermaid-frame not-prose";
      el.parentNode.insertBefore(frame, el);
      frame.appendChild(el);

      if (expandBtnTpl) {
        const btn = expandBtnTpl.content.firstElementChild.cloneNode(true);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          openMermaidModal(el);
        });
        frame.appendChild(btn);
      }
      el.addEventListener("click", () => openMermaidModal(el));
    }
  });

  function buildMermaidConfig(isDark) {
    return {
      startOnLoad: false,
      theme: "base",
      securityLevel: "loose",
      flowchart: {
        curve: "basis",
        htmlLabels: true,
        padding: 14,
        nodeSpacing: 32,
        rankSpacing: 48,
        subGraphTitleMargin: { top: 10, bottom: 8 },
      },
      themeVariables: isDark
        ? {
            darkMode: true,
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: "14px",
            background: "transparent",
            primaryColor: "#181d26",
            primaryTextColor: "#f3f5f8",
            primaryBorderColor: "#353f52",
            lineColor: "#d4ff3a",
            secondaryColor: "#12161e",
            tertiaryColor: "#12161e",
            clusterBkg: "#11151d",
            clusterBorder: "#262d3b",
            titleColor: "#94a3b8",
            edgeLabelBackground: "transparent",
            nodeTextColor: "#f3f5f8",
          }
        : {
            darkMode: false,
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: "14px",
            background: "transparent",
            primaryColor: "#ffffff",
            primaryTextColor: "#0f172a",
            primaryBorderColor: "#cbd5e1",
            lineColor: "#2563eb",
            secondaryColor: "#f1f5f9",
            tertiaryColor: "#f8fafc",
            clusterBkg: "#f1f5f9",
            clusterBorder: "#cbd5e1",
            titleColor: "#475569",
            edgeLabelBackground: "transparent",
            nodeTextColor: "#0f172a",
          },
    };
  }

  function polishSvg(container, isDark) {
    const svg = container.querySelector("svg");
    if (!svg) return;
    container.dataset.polished = "1";
    svg.querySelectorAll(".node rect, .node polygon, .node path.label-container").forEach((r) => {
      r.setAttribute("rx", "10");
      r.setAttribute("ry", "10");
      r.style.stroke = isDark ? "#353f52" : "#cbd5e1";
      r.style.strokeWidth = "1.5px";
      r.style.filter = isDark
        ? "drop-shadow(0 4px 10px rgba(0,0,0,0.45))"
        : "drop-shadow(0 2px 6px rgba(15,23,42,0.06))";
    });
    svg.querySelectorAll(".cluster rect").forEach((r) => {
      r.setAttribute("rx", "14");
      r.setAttribute("ry", "14");
      r.style.fill = isDark ? "#12161f" : "#f1f5f9";
      r.style.stroke = isDark ? "#2a3344" : "#cbd5e1";
      r.style.strokeWidth = "1.25px";
      r.style.strokeDasharray = "5 4";
      r.style.filter = "none";
    });
    svg.querySelectorAll(".edgePath path").forEach((p) => {
      p.style.strokeWidth = "2px";
    });
    svg.querySelectorAll(".labelBkg, .edgeLabel rect").forEach((b) => {
      b.style.background = "transparent";
      b.style.backgroundColor = "transparent";
      b.style.fill = "transparent";
      b.style.stroke = "none";
    });
    svg.querySelectorAll("foreignObject").forEach((fo) => {
      fo.style.overflow = "visible";
    });

    const paths = Array.from(svg.querySelectorAll(".edgePaths path"));
    const labelGroups = Array.from(svg.querySelectorAll(".edgeLabels > g.edgeLabel"));
    labelGroups.forEach((g, idx) => {
      const span = g.querySelector("span.edgeLabel");
      const path = paths[idx];
      if (!span || !path) return;
      const hasBreak = !!span.querySelector("br");
      span.classList.toggle("is-single-line", !hasBreak);

      const tf = g.getAttribute("transform") || "";
      const m = tf.match(/translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
      if (!m) return;
      const gx = parseFloat(m[1]);
      const gy = parseFloat(m[2]);

      let wireSvgY = gy;
      try {
        const total = path.getTotalLength();
        let bestDist = Infinity;
        const steps = 40;
        for (let s = 0; s <= steps; s++) {
          const pt = path.getPointAtLength((total * s) / steps);
          const dx = Math.abs(pt.x - gx);
          if (dx < bestDist) {
            bestDist = dx;
            wireSvgY = pt.y;
          }
        }
      } catch (_) {}

      if (!hasBreak) {
        g.setAttribute("transform", `translate(${gx}, ${wireSvgY - 13})`);
        const wireClient = (() => {
          const p = svg.createSVGPoint();
          p.x = gx;
          p.y = wireSvgY;
          const ctm = path.getScreenCTM();
          return ctm ? p.matrixTransform(ctm).y : null;
        })();
        const sr = span.getBoundingClientRect();
        const ctm = g.getScreenCTM();
        if (wireClient !== null && ctm && ctm.d > 0 && sr.height > 0) {
          const desiredBottom = wireClient - 5 * ctm.d;
          const deltaSvgY = (desiredBottom - sr.bottom) / ctm.d;
          g.setAttribute("transform", `translate(${gx}, ${wireSvgY - 13 + deltaSvgY})`);
        }
      } else {
        g.setAttribute("transform", `translate(${gx}, ${wireSvgY})`);
        const textNodes = [];
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (!n.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          textNodes.push(range.getBoundingClientRect());
        }
        const ctm = g.getScreenCTM();
        if (textNodes.length >= 2 && ctm && ctm.d > 0) {
          const p = svg.createSVGPoint();
          p.x = gx;
          p.y = wireSvgY;
          const wireClientY = p.matrixTransform(path.getScreenCTM()).y;
          const gapMidClientY = (textNodes[0].bottom + textNodes[1].top) / 2;
          const deltaSvgY = (wireClientY - gapMidClientY) / ctm.d;
          g.setAttribute("transform", `translate(${gx}, ${wireSvgY + deltaSvgY})`);
        }
      }
    });
  }

  mermaid.initialize(buildMermaidConfig(document.documentElement.classList.contains("dark")));

  let queue = Promise.resolve();
  const renderVisible = () => {
    queue = queue.then(async () => {
      const isDark = document.documentElement.classList.contains("dark");
      mermaid.initialize(buildMermaidConfig(isDark));
      const nodes = Array.from(document.querySelectorAll(".mermaid:not([data-processed])")).filter(
        (el) => el.offsetParent !== null
      );
      if (nodes.length) {
        await mermaid.run({ nodes }).catch(console.error);
        nodes.forEach((n) => polishSvg(n, isDark));
      }
    });
  };

  renderVisible();

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting && !e.target.dataset.processed)) {
      renderVisible();
    }
  });
  document.querySelectorAll(".mermaid").forEach((el) => observer.observe(el));

  let timeout;
  new MutationObserver(() => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      document.querySelectorAll(".mermaid[data-processed]").forEach((el) => {
        el.innerHTML = el.dataset.original;
        el.removeAttribute("data-processed");
        el.removeAttribute("data-polished");
      });
      renderVisible();
    }, 120);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});
