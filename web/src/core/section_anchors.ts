import { AppStore } from "../state/store";
import {
  buildSectionHash,
  getCurrentParsedHash,
  onSectionAnchorChange,
  replaceAppHash,
  RouteId,
} from "./router";

function slugifyHeading(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isVerticalSectionRoute(route: RouteId): boolean {
  return route !== "races" && route !== "live";
}

function routeSafeId(route: RouteId, anchor: string): string {
  return `${route}-${anchor}`;
}

/**
 * Manages URL section anchors (`#/<route>/<section>`) on scrollable vertical pages:
 * 1. Updates the URL bar via `replaceState` as sections scroll into focus (without spamming Back history).
 * 2. Restores scroll position to the exact section across page refreshes (`F5`), bookmarks, and Back/Forward.
 */
export class SectionAnchorTracker {
  private readonly outletEl: HTMLElement;
  private readonly store: AppStore;
  private activeRoute: RouteId = "live";
  private suppressSpyUntil = 0;
  private pendingInitialAnchor = "";
  private userHasScrolled = false;
  private rafId = 0;
  private settleTimers: number[] = [];
  private readonly unsubAnchor: () => void;
  private readonly unsubStore: () => void;

  constructor(outletEl: HTMLElement, store: AppStore) {
    this.outletEl = outletEl;
    this.store = store;

    window.addEventListener("scroll", this.handleScroll, { passive: true });
    window.addEventListener("wheel", this.markUserInteracted, { passive: true });
    window.addEventListener("touchmove", this.markUserInteracted, { passive: true });

    this.unsubAnchor = onSectionAnchorChange((anchor, route) => {
      if (route !== this.activeRoute || !isVerticalSectionRoute(route)) return;
      this.pendingInitialAnchor = anchor;
      this.scrollToAnchor(anchor, true);
    });

    // Re-align initial anchor once store hydration populates dynamic cards (if user hasn't scrolled manually)
    this.unsubStore = this.store.subscribe(["config", "status", "laps", "practice", "race"], () => {
      if (
        this.pendingInitialAnchor &&
        !this.userHasScrolled &&
        isVerticalSectionRoute(this.activeRoute)
      ) {
        this.ensureAutoAnchors();
        this.scrollToAnchor(this.pendingInitialAnchor, false);
      }
    });
  }

  public onRouteMounted(route: RouteId, savedScrollY?: number, wasCached = false): void {
    this.clearSettleTimers();
    this.activeRoute = route;
    this.userHasScrolled = false;

    if (!isVerticalSectionRoute(route)) {
      this.pendingInitialAnchor = "";
      this.suppressSpyUntil = performance.now() + 250;
      window.scrollTo({ top: wasCached && savedScrollY ? savedScrollY : 0 });
      return;
    }

    this.ensureAutoAnchors();
    const parsed = getCurrentParsedHash();
    const targetAnchor = parsed.route === route ? (parsed.sectionAnchor ?? "") : "";

    if (!targetAnchor && wasCached && typeof savedScrollY === "number" && savedScrollY > 0) {
      this.pendingInitialAnchor = "";
      this.suppressSpyUntil = performance.now() + 320;
      window.scrollTo({ top: savedScrollY });
      requestAnimationFrame(() => {
        if (!this.userHasScrolled && this.activeRoute === route) {
          window.scrollTo({ top: savedScrollY });
        }
      });
      return;
    }

    this.pendingInitialAnchor = targetAnchor;

    if (!targetAnchor) {
      this.suppressSpyUntil = performance.now() + 220;
      window.scrollTo({ top: 0 });
      return;
    }

    // Suppress scroll-spy overwrites while initial layout + jump-to-section settle
    this.suppressSpyUntil = performance.now() + 900;
    const attemptJump = (): void => {
      if (this.userHasScrolled || this.activeRoute !== route) return;
      this.ensureAutoAnchors();
      if (this.scrollToAnchor(targetAnchor, false)) {
        // Keep re-verifying briefly across async widget/canvas renders
        this.suppressSpyUntil = Math.max(this.suppressSpyUntil, performance.now() + 450);
      }
    };

    attemptJump();
    requestAnimationFrame(() => attemptJump());
    for (const delayMs of [80, 220, 480]) {
      this.settleTimers.push(window.setTimeout(attemptJump, delayMs));
    }
    this.settleTimers.push(
      window.setTimeout(() => {
        if (!this.userHasScrolled) {
          this.pendingInitialAnchor = "";
        }
      }, 950)
    );
  }

  public destroy(): void {
    this.clearSettleTimers();
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    window.removeEventListener("scroll", this.handleScroll);
    window.removeEventListener("wheel", this.markUserInteracted);
    window.removeEventListener("touchmove", this.markUserInteracted);
    this.unsubAnchor();
    this.unsubStore();
  }

  private clearSettleTimers(): void {
    for (const t of this.settleTimers) {
      window.clearTimeout(t);
    }
    this.settleTimers = [];
  }

  private markUserInteracted = (): void => {
    this.userHasScrolled = true;
    this.pendingInitialAnchor = "";
  };

  private activeViewRoot(): ParentNode {
    return this.outletEl.querySelector<HTMLElement>(".view:not([hidden])") ?? this.outletEl;
  }

  private ensureAutoAnchors(): void {
    const root = this.activeViewRoot();
    const used = new Set<string>();
    root.querySelectorAll<HTMLElement>("[data-section-anchor]").forEach((el) => {
      const a = el.dataset.sectionAnchor || "";
      if (a) {
        used.add(a);
        if (!el.id) el.id = `sec-${routeSafeId(this.activeRoute, a)}`;
      }
    });

    root.querySelectorAll<HTMLElement>("section.settings-section").forEach((sec) => {
      if (sec.dataset.sectionAnchor) return;
      const h2 = sec.querySelector("h2");
      const base = slugifyHeading(h2?.textContent ?? "");
      if (!base) return;
      let slug = base;
      let i = 2;
      while (used.has(slug)) {
        slug = `${base}-${i++}`;
      }
      used.add(slug);
      sec.dataset.sectionAnchor = slug;
      if (!sec.id) sec.id = `sec-${routeSafeId(this.activeRoute, slug)}`;
    });
  }

  private getVisibleSections(): HTMLElement[] {
    this.ensureAutoAnchors();
    const root = this.activeViewRoot();
    const list: HTMLElement[] = [];
    root.querySelectorAll<HTMLElement>("[data-section-anchor]").forEach((el) => {
      if (!el.dataset.sectionAnchor) return;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0) {
        list.push(el);
      }
    });
    return list;
  }

  private scrollToAnchor(anchor: string, smooth: boolean): boolean {
    if (!anchor) {
      this.suppressSpyUntil = performance.now() + (smooth ? 450 : 220);
      window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
      return true;
    }

    const sections = this.getVisibleSections();
    const match = sections.find((el) => el.dataset.sectionAnchor === anchor);
    if (!match) return false;

    const topbarH = document.querySelector<HTMLElement>(".topbar")?.offsetHeight || 64;
    const targetTop = Math.max(
      0,
      Math.round(window.scrollY + match.getBoundingClientRect().top - topbarH - 18)
    );
    this.suppressSpyUntil = performance.now() + (smooth ? 520 : 280);
    window.scrollTo({ top: targetTop, behavior: smooth ? "smooth" : "auto" });
    return true;
  }

  private handleScroll = (): void => {
    if (!isVerticalSectionRoute(this.activeRoute)) return;
    if (this.rafId !== 0) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      this.syncActiveSectionToHash();
    });
  };

  private syncActiveSectionToHash(): void {
    if (!isVerticalSectionRoute(this.activeRoute)) return;
    if (performance.now() < this.suppressSpyUntil) return;

    const sections = this.getVisibleSections();
    if (sections.length <= 1) {
      return;
    }

    const scrollY = window.scrollY;
    if (scrollY < 56) {
      replaceAppHash(buildSectionHash(this.activeRoute, undefined));
      return;
    }

    const topbarH = document.querySelector<HTMLElement>(".topbar")?.offsetHeight || 64;
    const focusLine = topbarH + 96;
    const docH = document.documentElement.scrollHeight;
    const atPageBottom = window.innerHeight + scrollY >= docH - 28;

    let activeEl: HTMLElement = sections[0];
    if (atPageBottom) {
      for (const el of sections) {
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.78) {
          activeEl = el;
        }
      }
    } else {
      for (const el of sections) {
        const r = el.getBoundingClientRect();
        if (r.top <= focusLine) {
          activeEl = el;
        } else {
          break;
        }
      }
    }

    // If still on the very first section near top, keep base URL clean unless scrolled past its header
    const firstRect = sections[0].getBoundingClientRect();
    const anchor =
      activeEl === sections[0] && firstRect.top > topbarH - 24
        ? undefined
        : activeEl.dataset.sectionAnchor;

    replaceAppHash(buildSectionHash(this.activeRoute, anchor));
  }
}
