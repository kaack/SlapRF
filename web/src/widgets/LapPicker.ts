import { Component } from "../core/component";
import { fmtTime } from "../core/format";
import { resolveComparison, rollingAverages } from "../state/analysis";
import { lapsFor, median } from "../state/selectors";
import { AppStore } from "../state/store";
import { LapRecord } from "../types/models";
import { renderEmpty } from "./markup";

const CHART_W = 1000;
const CHART_H = 150;
/** Maximum number of laps visible in the viewport width before horizontal scrolling kicks in. */
const WINDOW_LAPS_DESKTOP = 50;
const WINDOW_LAPS_MOBILE = 16;
/** Slow laps beyond this × median (crashes, landings) are clipped so normal laps keep their resolution. */
const OUTLIER_FACTOR = 1.35;

/**
 * Two-click lap selection chart:
 *   - 1st bar click selects the lap being reviewed (Lap A).
 *   - 2nd bar click on another bar selects the comparison baseline (Lap B), or use the
 *     top-right "Compare with" presets (Personal best / Previous lap).
 *   - Defaults to showing the most recent 50 laps and scrolls horizontally for earlier laps.
 */
export class LapPicker extends Component {
  private readonly store: AppStore;
  private hoveredLapId: number | null = null;
  private activeSlot: "review" | "ref" = "review";
  private followLatest = true;
  private savedScrollLeft = 0;
  private lastPilotSlot: number | null = null;
  private chartPan: { startX: number; startScrollLeft: number; moved: boolean } | null = null;
  private suppressClick = false;
  private wasMobileWindow = false;
  /** Geometry of the last rendered chart, used to place the hover lap-time label. */
  private chartGeom: {
    laps: LapRecord[];
    xPct: number[];
    barTopPct: number[];
    labelled: Set<number>;
    edgeClass: (i: number) => string;
  } | null = null;

  private windowLaps(): number {
    return window.innerWidth <= 680 ? WINDOW_LAPS_MOBILE : WINDOW_LAPS_DESKTOP;
  }

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;
    this.wasMobileWindow = window.innerWidth <= 680;

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
      const pickSlotBtn = target.closest<HTMLElement>("[data-pick-slot]");
      if (pickSlotBtn) {
        const slot = pickSlotBtn.dataset.pickSlot;
        this.activeSlot = slot === "ref" ? "ref" : "review";
        this.render();
        return;
      }
      const refPreset = target.closest<HTMLElement>("[data-ref]");
      if (refPreset) {
        this.setRefPreset(refPreset.dataset.ref!);
        return;
      }
      const bar = target.closest<SVGElement>("[data-lap]");
      if (bar) {
        this.onBarClick(Number(bar.dataset.lap));
      }
    };

    this.listen(el, "pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const target = e.target as HTMLElement;

      if (e.pointerType === "mouse") {
        const scrollArea = target.closest<HTMLElement>(".lap-picker-scroll.is-scrollable");
        if (scrollArea) {
          this.chartPan = { startX: e.clientX, startScrollLeft: scrollArea.scrollLeft, moved: false };
          return;
        }
        handleAction(e);
      }
    });
    this.listen(el, "click", handleAction);

    this.listen(el, "pointermove", (e) => {
      if (this.chartPan) {
        const dx = e.clientX - this.chartPan.startX;
        if (!this.chartPan.moved && Math.abs(dx) > 5) {
          this.chartPan.moved = true;
          this.suppressClick = true;
          this.el.querySelector<HTMLElement>(".lap-picker-scroll")?.classList.add("is-panning");
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
      if (this.chartPan) {
        const wasClick = !this.chartPan.moved;
        this.chartPan = null;
        this.el.querySelector<HTMLElement>(".lap-picker-scroll")?.classList.remove("is-panning");
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
    const onResize = () => {
      const isMobile = window.innerWidth <= 680;
      if (isMobile !== this.wasMobileWindow) {
        this.wasMobileWindow = isMobile;
        this.render();
      }
    };
    window.addEventListener("resize", onResize, { passive: true });
    this.onDispose(() => window.removeEventListener("resize", onResize));
    this.render();
  }

  private onScroll(scroller: HTMLElement): void {
    this.savedScrollLeft = scroller.scrollLeft;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    this.followLatest = scroller.scrollLeft >= maxScroll - 8;
    this.syncLatestButton();
    this.syncHoveredPin();
  }

  private scrollToLatest(): void {
    const scroller = this.el.querySelector<HTMLElement>(".lap-picker-scroll");
    if (!scroller) return;
    scroller.scrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    this.savedScrollLeft = scroller.scrollLeft;
  }

  private syncLatestButton(): void {
    const btn = this.el.querySelector<HTMLElement>("[data-scroll-latest]");
    if (!btn) return;
    btn.style.display = this.followLatest ? "none" : "";
  }

  private syncHoveredPin(): void {
    this.el.querySelectorAll<SVGElement>(".bar-hit[data-lap]").forEach((g) => {
      g.classList.toggle("is-hovered", Number(g.dataset.lap) === this.hoveredLapId);
    });

    // Hovering an unselected bar prints its lap time above it, like the selected bars have.
    const label = this.el.querySelector<HTMLElement>("[data-hover-time]");
    const geom = this.chartGeom;
    const idx = geom && this.hoveredLapId !== null ? geom.laps.findIndex((l) => l.lapId === this.hoveredLapId) : -1;
    if (!label || !geom || idx < 0 || geom.labelled.has(this.hoveredLapId!)) {
      if (label) label.hidden = true;
      return;
    }
    label.textContent = fmtTime(geom.laps[idx].lapTimeSec);
    label.className = `bar-time is-hover ${geom.edgeClass(idx)}`;
    label.style.left = `${geom.xPct[idx].toFixed(2)}%`;
    label.style.top = `${geom.barTopPct[idx].toFixed(2)}%`;
    label.hidden = false;
  }

  private onBarClick(lapId: number): void {
    const laps = lapsFor(this.store, this.store.selectedPilot);
    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    const currentReviewId = cmp?.lap.lapId ?? laps[laps.length - 1]?.lapId;

    if (this.activeSlot === "ref" && laps.length >= 2 && lapId !== currentReviewId) {
      this.activeSlot = "review";
      this.store.setComparison({ reference: lapId });
      return;
    }

    this.activeSlot = "review";
    const ref = this.store.comparison.reference;
    this.store.setComparison(ref === lapId ? { lapId, reference: "best" } : { lapId });
  }

  private setRefPreset(choice: string): void {
    if (choice === "custom") {
      this.activeSlot = "ref";
      this.render();
      return;
    }
    this.activeSlot = "review";
    this.store.setComparison({ reference: choice === "previous" ? "previous" : "best" });
  }

  public restoreDefaults(): void {
    this.activeSlot = "review";
    this.followLatest = true;
    this.savedScrollLeft = 0;
    this.store.setComparison({ lapId: null, reference: "best" });
    this.render();
  }

  private render(): void {
    if (this.lastPilotSlot !== this.store.selectedPilot) {
      this.lastPilotSlot = this.store.selectedPilot;
      this.activeSlot = "review";
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
      this.chartGeom = null;
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
      }
      this.syncLatestButton();
    }
    this.syncHoveredPin();
  }

  private renderHead(lapCount: number, refLap: LapRecord | undefined): string {
    const winLaps = this.windowLaps();
    const scrollable = lapCount > winLaps;
    const canCompare = lapCount >= 2;
    const refMode = this.store.comparison.reference;
    const picking = this.activeSlot === "ref";
    const customActive = picking || typeof refMode === "number";
    const customLabel = picking
      ? "Click a bar…"
      : typeof refMode === "number" && refLap
      ? `Lap ${refLap.lapNumber}`
      : "Pick a lap";
    const btn = (key: string, label: string, active: boolean, extra = "") =>
      `<button type="button" data-ref="${key}" class="${active ? "is-active" : ""} ${extra}" ${canCompare ? "" : "disabled"}>${label}</button>`;
    const jumpLatest = scrollable
      ? `<button type="button" class="btn btn-sm btn-ghost" data-scroll-latest style="${this.followLatest ? "display:none" : ""}">Latest ${winLaps} →</button>`
      : "";
    return `
      <header class="card-head">
        <div class="settings-intro">
          <h2>Lap stats</h2>
          <p>Click any bar to inspect that lap, then choose what to compare it against.</p>
        </div>
        <div class="cmp-with">
          ${jumpLatest}
          <span>Compare against</span>
          <div class="segmented">
            ${btn("best", "Personal best", refMode === "best" && !customActive)}
            ${btn("previous", "Previous lap", refMode === "previous" && !customActive)}
            ${btn("custom", customLabel, customActive, "is-ref-chip")}
          </div>
        </div>
      </header>`;
  }

  private renderChart(laps: LapRecord[], reviewId: number, refId: number): string {
    const winLaps = this.windowLaps();
    const times = laps.map((l) => l.lapTimeSec);
    const best = Math.min(...times);
    const sorted = [...times].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const hi = Math.min(Math.max(...times), median(times) * OUTLIER_FACTOR, q(0.95) + (q(0.95) - q(0.05)) * 0.5);
    const floor = Math.max(best, q(0.05) - (q(0.95) - q(0.05)) * 0.5);
    const lo = floor - Math.max(0.02, (hi - floor) * 0.25);
    const span = Math.max(0.001, hi - lo);

    const scrollable = laps.length > winLaps;
    const trackWidthPct = scrollable ? (laps.length / winLaps) * 100 : 100;
    const svgW = scrollable ? Math.round((laps.length / winLaps) * CHART_W) : CHART_W;
    const slot = svgW / laps.length;
    const barW = Math.max(4, Math.min(26, slot * 0.72));
    const MIN_BAR = 6;
    const yOf = (t: number) => Math.min(CHART_H - MIN_BAR, CHART_H - ((Math.min(t, hi) - lo) / span) * (CHART_H - 8));
    const xPct = (i: number) => ((i * slot + slot / 2) / svgW) * 100;

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
        return `
          <g data-lap="${l.lapId}" class="bar-hit ${hovered}">
            <rect class="hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${CHART_H}"/>
            <rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(CHART_H - y).toFixed(1)}" rx="2"/>
          </g>`;
      })
      .join("");
    const avgs = rollingAverages(laps);
    const avgPts = avgs.map((a, i) => ({ x: i * slot + slot / 2, y: yOf(a) }));

    // Labels stay centred over their bar; only the first/last bar in a dense chart (where a
    // centred label would be clipped at the chart edge) gets edge-aligned.
    const dense = slot < 44;
    const edgeClass = (i: number) => (!dense ? "" : i === laps.length - 1 ? "is-right" : i === 0 ? "is-left" : "");

    // Lap-time labels above the inspected and baseline bars. Neighbouring bars would put both
    // labels in the same spot, so line them up above the taller bar and lift the baseline one.
    const review = laps.find((l) => l.lapId === reviewId);
    const ref = laps.find((l) => l.lapId === refId);
    const close = review && ref ? Math.abs(laps.indexOf(review) - laps.indexOf(ref)) * slot < 110 : false;
    const taller = review && ref ? (review.lapTimeSec > ref.lapTimeSec ? review : ref) : undefined;
    const timeLabel = (lap: LapRecord, cls: string, raised: boolean) => {
      const i = laps.indexOf(lap);
      const anchor = close && taller ? taller : lap;
      return `<span class="bar-time ${cls} ${edgeClass(i)} ${raised ? "is-raised" : ""}" style="left:${xPct(i).toFixed(2)}%;top:${((yOf(anchor.lapTimeSec) / CHART_H) * 100).toFixed(2)}%">${fmtTime(lap.lapTimeSec)}</span>`;
    };
    const labels = (review ? timeLabel(review, "is-review", false) : "") + (ref ? timeLabel(ref, "is-ref", close) : "");

    this.chartGeom = {
      laps,
      xPct: laps.map((_, i) => xPct(i)),
      barTopPct: laps.map((l) => (yOf(l.lapTimeSec) / CHART_H) * 100),
      labelled: new Set([reviewId, refId]),
      edgeClass,
    };

    const visibleCount = Math.min(laps.length, winLaps);
    const every = Math.max(1, Math.ceil(visibleCount / 16));
    const axis = laps
      .map((l, i) => (i % every === 0 || i === laps.length - 1 ? `<span style="left:${xPct(i).toFixed(2)}%">${l.lapNumber}</span>` : ""))
      .join("");

    return `
      <div class="lap-picker ${this.activeSlot === "ref" ? "is-picking" : ""}">
        <div class="lap-picker-scroll ${scrollable ? "is-scrollable" : ""}">
          <div class="lap-picker-track" style="width:${trackWidthPct.toFixed(2)}%">
            <div class="lap-picker-plot ${close ? "has-stacked-labels" : ""}">
              <div class="lap-picker-bars">
                <svg viewBox="0 0 ${svgW} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="Lap times this session">
                  ${bars}
                  <path class="avg-line" d="${smoothPath(avgPts)}" vector-effect="non-scaling-stroke"/>
                </svg>
                ${labels}
                <span class="bar-time is-hover" data-hover-time hidden></span>
              </div>
            </div>
            <div class="lap-picker-axis" ${scrollable ? 'title="Drag left or right to scroll through laps"' : ""}>${axis}</div>
          </div>
        </div>
      </div>
      <div class="lap-chart-legend">
        <span><i class="lg-review"></i>Inspected lap</span>
        <span><i class="lg-ref"></i>Baseline lap</span>
        <span><i class="lg-best"></i>Personal best</span>
        <span><i class="lg-line"></i>5-lap average</span>
      </div>`;
  }
}

/** Smooth monotone cubic path through the points (no overshoot between laps). */
function smoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  if (n === 1) return d;
  if (n === 2) return `${d} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
  const dx = pts.slice(0, -1).map((p, i) => pts[i + 1].x - p.x);
  const m = dx.map((w, i) => (w !== 0 ? (pts[i + 1].y - pts[i].y) / w : 0));
  const t: number[] = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const seg = dx[i] / 3;
    d += ` C${(pts[i].x + seg).toFixed(1)},${(pts[i].y + t[i] * seg).toFixed(1)} ${(pts[i + 1].x - seg).toFixed(1)},${(pts[i + 1].y - t[i + 1] * seg).toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}
