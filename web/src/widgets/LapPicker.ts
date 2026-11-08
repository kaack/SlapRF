import { Component } from "../core/component";
import { fmtTime } from "../core/format";
import { icons } from "../core/icons";
import { resolveComparison, rollingAverages } from "../state/analysis";
import { lapsFor, median } from "../state/selectors";
import { AppStore } from "../state/store";
import { LapRecord } from "../types/models";
import { renderEmpty } from "./markup";

const CHART_W = 1000;
const CHART_H = 150;
/** Maximum number of laps visible in the viewport width before horizontal scrolling kicks in. */
const WINDOW_LAPS = 50;
/** Slow laps beyond this × median (crashes, landings) are clipped so normal laps keep their resolution. */
const OUTLIER_FACTOR = 1.35;

/**
 * Step 1 of pilot analysis — the only place laps are chosen.
 *   - Left-click any bar to immediately select it as the lap being reviewed.
 *   - Click the target icon underneath a bar, right-click the bar, or use the top-right
 *     "Compare with" presets to choose the comparison baseline.
 *   - Defaults to showing the most recent 50 laps and scrolls horizontally for earlier laps.
 */
export class LapPicker extends Component {
  private readonly store: AppStore;
  private hoveredLapId: number | null = null;
  private followLatest = true;
  private savedScrollLeft = 0;
  private lastPilotSlot: number | null = null;
  private sbDrag: { startX: number; startScrollLeft: number } | null = null;
  private chartPan: { startX: number; startScrollLeft: number; moved: boolean } | null = null;
  private suppressClick = false;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;

    const handleAction = (e: Event) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const target = e.target as Element;
      const latestBtn = target.closest<HTMLElement>("[data-scroll-latest]");
      if (latestBtn) {
        this.followLatest = true;
        this.scrollToLatest();
        this.syncLatestButton();
        return;
      }
      const setRefBtn = target.closest<HTMLElement>("[data-set-ref]");
      if (setRefBtn) {
        e.stopPropagation();
        this.selectBaseline(Number(setRefBtn.dataset.setRef));
        return;
      }
      const refPreset = target.closest<HTMLElement>("[data-ref]");
      if (refPreset) {
        this.setRefPreset(refPreset.dataset.ref!);
        return;
      }
      const bar = target.closest<SVGElement>("[data-lap]");
      if (bar) {
        this.selectReview(Number(bar.dataset.lap));
      }
    };

    this.listen(el, "pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const sbTrack = target.closest<HTMLElement>("[data-sb-track]");
      if (sbTrack) {
        e.preventDefault();
        const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
        if (!scroller) return;
        const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        if (maxScroll <= 0) return;
        const rect = sbTrack.getBoundingClientRect();
        const thumb = sbTrack.querySelector<HTMLElement>("[data-sb-thumb]");
        const thumbW = thumb ? thumb.getBoundingClientRect().width : 32;
        const travel = Math.max(1, rect.width - thumbW);
        // If clicking on the track outside the thumb, jump the thumb there first.
        if (!target.closest("[data-sb-thumb]")) {
          const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left - thumbW / 2) / travel));
          scroller.scrollLeft = clickRatio * maxScroll;
          this.onScroll(scroller);
        }
        this.sbDrag = { startX: e.clientX, startScrollLeft: scroller.scrollLeft };
        sbTrack.classList.add("is-dragging");
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Ignore synthetic pointer capture errors
        }
        return;
      }

      const scrollArea = target.closest<HTMLElement>(".lap-picker-scroll.is-scrollable");
      if (scrollArea && !target.closest("[data-set-ref]")) {
        this.chartPan = { startX: e.clientX, startScrollLeft: scrollArea.scrollLeft, moved: false };
        return;
      }

      handleAction(e);
    });
    this.listen(el, "click", handleAction);

    this.listen(el, "pointermove", (e) => {
      if (this.sbDrag) {
        const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
        const sbTrack = this.el.querySelector<HTMLElement>("[data-sb-track]");
        const thumb = this.el.querySelector<HTMLElement>("[data-sb-thumb]");
        if (scroller && sbTrack && thumb) {
          const maxScroll = Math.max(1, scroller.scrollWidth - scroller.clientWidth);
          const travel = Math.max(1, sbTrack.clientWidth - thumb.offsetWidth);
          const dx = e.clientX - this.sbDrag.startX;
          scroller.scrollLeft = Math.max(0, Math.min(maxScroll, this.sbDrag.startScrollLeft + (dx / travel) * maxScroll));
          this.onScroll(scroller);
        }
        return;
      }

      if (this.chartPan) {
        const dx = e.clientX - this.chartPan.startX;
        if (!this.chartPan.moved && Math.abs(dx) > 5) {
          this.chartPan.moved = true;
          this.suppressClick = true;
          try {
            el.setPointerCapture(e.pointerId);
          } catch {
            // Ignore
          }
        }
        if (this.chartPan.moved) {
          const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
          if (scroller) {
            scroller.scrollLeft = this.chartPan.startScrollLeft - dx;
            this.onScroll(scroller);
          }
          return;
        }
      }
      const track = this.el.querySelector<HTMLElement>(".lap-picker-track");
      if (!track) return;
      const laps = lapsFor(this.store, this.store.selectedPilot);
      if (laps.length === 0) return;
      const r = track.getBoundingClientRect();
      if (r.width <= 0) return;
      const relX = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
      const idx = Math.floor(relX * laps.length);
      const lapId = laps[idx]?.lapId ?? null;
      if (lapId !== this.hoveredLapId) {
        this.hoveredLapId = lapId;
        this.syncHoveredPin();
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (this.sbDrag) {
        this.sbDrag = null;
        this.el.querySelector<HTMLElement>("[data-sb-track]")?.classList.remove("is-dragging");
      }
      if (this.chartPan) {
        const wasClick = !this.chartPan.moved;
        this.chartPan = null;
        if (wasClick) {
          handleAction(e);
        }
      }
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    };
    this.listen(el, "pointerup", endDrag);
    this.listen(el, "pointercancel", endDrag);

    this.listen(el, "pointerleave", () => {
      if (this.hoveredLapId !== null) {
        this.hoveredLapId = null;
        this.syncHoveredPin();
      }
    });

    this.listen(el, "dblclick", (e) => {
      const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 2) return;
      if ((e.target as HTMLElement).closest("[data-set-ref], [data-ref]")) return;
      this.followLatest = true;
      this.scrollToLatest();
      this.syncLatestButton();
      this.syncScrollbar();
    });

    // Translate mouse wheel over the chart into horizontal scroll when there are more than 50 laps.
    this.listen(
      el,
      "wheel",
      (e) => {
        const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
        if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 2) return;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (delta === 0) return;
        e.preventDefault();
        scroller.scrollLeft += delta;
        this.onScroll(scroller);
      },
      { passive: false }
    );

    this.onDispose(store.subscribe(["laps", "selection", "config"], () => this.render()));
    this.render();
  }

  private onScroll(scroller: HTMLElement): void {
    this.savedScrollLeft = scroller.scrollLeft;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    this.followLatest = scroller.scrollLeft >= maxScroll - 8;
    this.syncLatestButton();
    this.syncScrollbar();
  }

  private scrollToLatest(): void {
    const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
    if (!scroller) return;
    scroller.scrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    this.savedScrollLeft = scroller.scrollLeft;
    this.syncScrollbar();
  }

  private syncScrollbar(): void {
    const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
    const thumb = this.el.querySelector<HTMLElement>("[data-sb-thumb]");
    if (!scroller || !thumb) return;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (maxScroll <= 0) return;
    const ratio = scroller.clientWidth / scroller.scrollWidth;
    const thumbPct = Math.max(6, Math.min(100, ratio * 100));
    const scrollRatio = Math.max(0, Math.min(1, scroller.scrollLeft / maxScroll));
    const leftPct = scrollRatio * (100 - thumbPct);
    thumb.style.width = `${thumbPct.toFixed(2)}%`;
    thumb.style.left = `${leftPct.toFixed(2)}%`;
  }

  private syncLatestButton(): void {
    const btn = this.el.querySelector<HTMLElement>("[data-scroll-latest]");
    if (!btn) return;
    btn.style.display = this.followLatest ? "none" : "";
  }

  private syncHoveredPin(): void {
    this.el.querySelectorAll<HTMLElement>(".lap-pin-btn[data-set-ref]").forEach((btn) => {
      btn.classList.toggle("is-hovered", Number(btn.dataset.setRef) === this.hoveredLapId);
    });
    this.el.querySelectorAll<SVGElement>(".bar-hit[data-lap]").forEach((g) => {
      g.classList.toggle("is-hovered", Number(g.dataset.lap) === this.hoveredLapId);
    });
  }

  private selectReview(lapId: number): void {
    // If this lap was the custom reference, fall back to personal best rather than comparing it to itself.
    const ref = this.store.comparison.reference;
    this.store.setComparison(ref === lapId ? { lapId, reference: "best" } : { lapId });
  }

  private selectBaseline(lapId: number): void {
    const laps = lapsFor(this.store, this.store.selectedPilot);
    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    const currentReviewId = cmp?.lap.lapId ?? laps[laps.length - 1]?.lapId;
    if (currentReviewId === lapId && laps.length >= 2) {
      const fallbackReview = [...laps].reverse().find((l) => l.lapId !== lapId);
      this.store.setComparison({
        lapId: fallbackReview ? fallbackReview.lapId : null,
        reference: lapId,
      });
    } else {
      this.store.setComparison({ reference: lapId });
    }
  }

  private setRefPreset(choice: string): void {
    this.store.setComparison({ reference: choice === "previous" ? "previous" : "best" });
  }

  private render(): void {
    if (this.lastPilotSlot !== this.store.selectedPilot) {
      this.lastPilotSlot = this.store.selectedPilot;
      this.followLatest = true;
      this.savedScrollLeft = 0;
    }

    const prevScroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
    if (prevScroller && prevScroller.scrollWidth > prevScroller.clientWidth + 2) {
      this.onScroll(prevScroller);
    }

    const laps = lapsFor(this.store, this.store.selectedPilot);
    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    const head = this.renderHead(laps.length, cmp?.ref);
    if (laps.length === 0) {
      this.el.innerHTML = head + renderEmpty("No laps yet", "Each completed lap shows up here as a bar.");
      return;
    }
    const reviewId = cmp?.lap.lapId ?? laps[laps.length - 1].lapId;
    const refId = cmp?.ref.lapId ?? -1;
    this.el.innerHTML = head + this.renderChart(laps, reviewId, refId);

    const nextScroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
    if (nextScroller) {
      nextScroller.addEventListener("scroll", () => this.onScroll(nextScroller), { passive: true });
      if (this.followLatest) {
        this.scrollToLatest();
      } else {
        nextScroller.scrollLeft = this.savedScrollLeft;
        this.syncScrollbar();
      }
      this.syncLatestButton();
    }
  }

  private renderHead(lapCount: number, refLap: LapRecord | undefined): string {
    const canCompare = lapCount >= 2;
    const scrollable = lapCount > WINDOW_LAPS;
    const ref = this.store.comparison.reference;
    const btn = (key: string, label: string, active: boolean) =>
      `<button type="button" data-ref="${key}" class="${active ? "is-active" : ""}" ${canCompare ? "" : "disabled"}>${label}</button>`;
    // A specific lap chosen as reference shows up as a third, already-active option.
    const custom =
      typeof ref === "number" && refLap
        ? `<button type="button" class="is-active is-ref-chip" data-ref="best" title="Click to reset baseline to Personal best">Lap ${refLap.lapNumber} ×</button>`
        : "";
    const scrollHint = scrollable
      ? ` · showing ${WINDOW_LAPS} laps at a time (${lapCount} total, scroll for earlier laps)`
      : "";
    const jumpLatest = scrollable
      ? `<button type="button" class="btn btn-sm btn-ghost" data-scroll-latest style="${this.followLatest ? "display:none" : ""}">Latest ${WINDOW_LAPS} →</button>`
      : "";
    return `
      <header class="card-head">
        <div>
          <h2><span class="step">1</span>Pick laps</h2>
          <p>Click any bar to review that lap · click the pin icon under a bar to set it as the baseline${scrollHint}.</p>
        </div>
        <div class="cmp-with">
          ${jumpLatest}
          <span>Compare with</span>
          <div class="segmented">
            ${btn("best", "Personal best", ref === "best")}
            ${btn("previous", "Previous lap", ref === "previous")}
            ${custom}
          </div>
        </div>
      </header>`;
  }

  private renderChart(laps: LapRecord[], reviewId: number, refId: number): string {
    const times = laps.map((l) => l.lapTimeSec);
    const best = Math.min(...times);
    // Scale to the typical spread of laps so lap-to-lap differences are visible; unusually
    // fast laps bottom out at a short stub, crash laps top out at full height.
    const sorted = [...times].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const hi = Math.min(Math.max(...times), median(times) * OUTLIER_FACTOR, q(0.95) + (q(0.95) - q(0.05)) * 0.5);
    const floor = Math.max(best, q(0.05) - (q(0.95) - q(0.05)) * 0.5);
    const lo = floor - Math.max(0.02, (hi - floor) * 0.25);
    const span = Math.max(0.001, hi - lo);

    const scrollable = laps.length > WINDOW_LAPS;
    const trackWidthPct = scrollable ? (laps.length / WINDOW_LAPS) * 100 : 100;
    const svgW = scrollable ? Math.round((laps.length / WINDOW_LAPS) * CHART_W) : CHART_W;
    const slot = svgW / laps.length;
    const barW = Math.max(4, Math.min(26, slot * 0.72));
    const MIN_BAR = 6;
    const yOf = (t: number) => Math.min(CHART_H - MIN_BAR, CHART_H - ((Math.min(t, hi) - lo) / span) * (CHART_H - 8));
    const xPct = (i: number) => ((i * slot + slot / 2) / svgW) * 100;
    const topPct = (l: LapRecord) => (yOf(l.lapTimeSec) / CHART_H) * 100;

    const bars = laps
      .map((l, i) => {
        const x = i * slot + (slot - barW) / 2;
        const y = yOf(l.lapTimeSec);
        const cls = [
          "bar",
          l.lapTimeSec === best ? "is-best" : "",
          l.lapId === reviewId ? "is-review" : "",
          l.lapId === refId ? "is-ref" : "",
        ].join(" ");
        const hovered = l.lapId === this.hoveredLapId ? "is-hovered" : "";
        // A full-height transparent hit area makes thin and short bars easy to click.
        return `
          <g data-lap="${l.lapId}" class="bar-hit ${hovered}">
            <rect class="hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${CHART_H}"/>
            <rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(CHART_H - y).toFixed(1)}" rx="2"/>
            <title>Lap ${l.lapNumber}: ${l.lapTimeSec.toFixed(3)}s — click to review</title>
          </g>`;
      })
      .join("");
    const avg = rollingAverages(laps)
      .map((a, i) => `${(i * slot + slot / 2).toFixed(1)},${yOf(a).toFixed(1)}`)
      .join(" ");

    // Name tags above the reviewed and reference bars, so the link to step 2 is obvious.
    const review = laps.find((l) => l.lapId === reviewId);
    const ref = laps.find((l) => l.lapId === refId);
    // Neighbouring laps would put both tags in the same spot: line both up above the taller
    // of the two bars and lift the reference tag a row.
    const close = review && ref ? Math.abs(laps.indexOf(review) - laps.indexOf(ref)) * slot < 120 : false;
    const taller = review && ref ? (review.lapTimeSec > ref.lapTimeSec ? review : ref) : undefined;
    const tag = (lap: LapRecord, cls: string, text: string, raised: boolean) => {
      const idx = laps.indexOf(lap);
      const left = xPct(idx);
      const top = topPct(close && taller ? taller : lap);
      return `<span class="lap-tag ${cls} ${idx >= laps.length - 2 ? "is-right" : idx <= 1 ? "is-left" : ""} ${raised ? "is-raised" : ""}"
                    style="left:${left.toFixed(2)}%;top:${top.toFixed(1)}%">${text}</span>`;
    };

    // Under-bar baseline pin icons: click the icon under any bar to make that lap the comparison baseline.
    const visibleCount = Math.min(laps.length, WINDOW_LAPS);
    const dense = visibleCount > 28;
    const pins = laps
      .map((l, i) => {
        const isRef = l.lapId === refId;
        const isHovered = l.lapId === this.hoveredLapId;
        return `<button
          type="button"
          class="lap-pin-btn ${isRef ? "is-active" : ""} ${isHovered ? "is-hovered" : ""}"
          data-set-ref="${l.lapId}"
          style="left:${xPct(i).toFixed(2)}%"
          title="${isRef ? `Lap ${l.lapNumber} is the current baseline` : `Pin Lap ${l.lapNumber} (${fmtTime(l.lapTimeSec)}) as baseline`}"
          aria-label="Pin Lap ${l.lapNumber} as baseline"
        >${icons.pin(13)}</button>`;
      })
      .join("");

    // Lap numbers along the bottom, spaced for a 50-lap window.
    const every = Math.max(1, Math.ceil(visibleCount / 16));
    const axis = laps
      .map((l, i) => (i % every === 0 || i === laps.length - 1 ? `<span style="left:${xPct(i).toFixed(2)}%">${l.lapNumber}</span>` : ""))
      .join("");

    const scrollbar = scrollable
      ? `<div class="lap-picker-sb-track" data-sb-track title="Drag or click to scroll through laps">
           <div class="lap-picker-sb-thumb" data-sb-thumb></div>
         </div>`
      : "";

    return `
      <div class="lap-picker">
        <div class="lap-picker-scroll ${scrollable ? "is-scrollable" : ""}">
          <div class="lap-picker-track" style="width:${trackWidthPct.toFixed(2)}%">
            <div class="lap-picker-plot">
              <div class="lap-picker-bars">
                <svg viewBox="0 0 ${svgW} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="Lap times this session">
                  ${bars}
                  <polyline class="avg-line" points="${avg}" vector-effect="non-scaling-stroke"/>
                </svg>
                ${review ? tag(review, "is-review", `Lap ${review.lapNumber} · ${fmtTime(review.lapTimeSec)}`, false) : ""}
                ${ref ? tag(ref, "is-ref", `Lap ${ref.lapNumber}`, close) : ""}
              </div>
            </div>
            <div class="lap-picker-pins ${dense ? "is-dense" : ""}" aria-label="Set baseline lap">${pins}</div>
            <div class="lap-picker-axis">${axis}</div>
          </div>
        </div>
        ${scrollbar}
      </div>
      <div class="lap-chart-legend">
        <span><i class="lg-review"></i>Reviewing (click bar)</span>
        <span><i class="lg-ref"></i>Baseline (click ${icons.pin(12)} under bar)</span>
        <span><i class="lg-best"></i>Personal best</span>
        <span><i class="lg-line"></i>5-lap average</span>
      </div>`;
  }
}
