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
/** Slow laps beyond this × median (crashes, landings) are clipped so normal laps keep their resolution. */
const OUTLIER_FACTOR = 1.35;

/**
 * Step 1 of pilot analysis — the only place laps are chosen.
 *   - Left-click any bar to immediately select it as the lap being reviewed.
 *   - Click the target icon underneath a bar, right-click the bar, or use the top-right
 *     "Compare with" presets to choose the comparison baseline.
 */
export class LapPicker extends Component {
  private readonly store: AppStore;
  private hoveredLapId: number | null = null;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;

    const handleAction = (e: Event) => {
      const target = e.target as Element;
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
      handleAction(e);
    });
    this.listen(el, "click", handleAction);

    // Right-click on any bar is a direct shortcut for setting the baseline.
    this.listen(el, "contextmenu", (e) => {
      const bar = (e.target as Element).closest<SVGElement>("[data-lap]");
      if (!bar) return;
      e.preventDefault();
      this.selectBaseline(Number(bar.dataset.lap));
    });

    // Track which bar column the pointer is over so dense sessions highlight the under-bar baseline icon.
    this.listen(el, "pointermove", (e) => {
      const plot = this.el.querySelector<HTMLElement>(".lap-picker");
      if (!plot) return;
      const laps = lapsFor(this.store, this.store.selectedPilot);
      if (laps.length === 0) return;
      const r = plot.getBoundingClientRect();
      if (r.width <= 0) return;
      const relX = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
      const idx = Math.floor(relX * laps.length);
      const lapId = laps[idx]?.lapId ?? null;
      if (lapId !== this.hoveredLapId) {
        this.hoveredLapId = lapId;
        this.syncHoveredPin();
      }
    });

    this.listen(el, "pointerleave", () => {
      if (this.hoveredLapId !== null) {
        this.hoveredLapId = null;
        this.syncHoveredPin();
      }
    });

    this.onDispose(store.subscribe(["laps", "selection", "config"], () => this.render()));
    this.render();
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
    const laps = lapsFor(this.store, this.store.selectedPilot);
    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    const head = this.renderHead(laps.length >= 2, cmp?.ref);
    if (laps.length === 0) {
      this.el.innerHTML = head + renderEmpty("No laps yet", "Each completed lap shows up here as a bar.");
      return;
    }
    const reviewId = cmp?.lap.lapId ?? laps[laps.length - 1].lapId;
    const refId = cmp?.ref.lapId ?? -1;
    this.el.innerHTML = head + this.renderChart(laps, reviewId, refId);
  }

  private renderHead(canCompare: boolean, refLap: LapRecord | undefined): string {
    const ref = this.store.comparison.reference;
    const btn = (key: string, label: string, active: boolean) =>
      `<button type="button" data-ref="${key}" class="${active ? "is-active" : ""}" ${canCompare ? "" : "disabled"}>${label}</button>`;
    // A specific lap chosen as reference shows up as a third, already-active option.
    const custom =
      typeof ref === "number" && refLap
        ? `<button type="button" class="is-active is-ref-chip" data-ref="best" title="Click to reset baseline to Personal best">Lap ${refLap.lapNumber} ×</button>`
        : "";
    return `
      <header class="card-head">
        <div>
          <h2><span class="step">1</span>Pick laps</h2>
          <p>Click any bar to review that lap · click the target icon under a bar (or right-click the bar) to set it as the baseline.</p>
        </div>
        <div class="cmp-with">
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
    const slot = CHART_W / laps.length;
    const barW = Math.max(2, Math.min(26, slot * 0.72));
    const MIN_BAR = 6;
    const yOf = (t: number) => Math.min(CHART_H - MIN_BAR, CHART_H - ((Math.min(t, hi) - lo) / span) * (CHART_H - 8));
    const xPct = (i: number) => ((i * slot + slot / 2) / CHART_W) * 100;
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
            <title>Lap ${l.lapNumber}: ${l.lapTimeSec.toFixed(3)}s — click to review, right-click to use as baseline</title>
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
      const left = xPct(laps.indexOf(lap));
      const top = topPct(close && taller ? taller : lap);
      return `<span class="lap-tag ${cls} ${left > 92 ? "is-right" : left < 8 ? "is-left" : ""} ${raised ? "is-raised" : ""}"
                    style="left:${left.toFixed(2)}%;top:${top.toFixed(1)}%">${text}</span>`;
    };

    // Under-bar baseline pin icons: click the icon under any bar to make that lap the comparison baseline.
    const dense = laps.length > 28;
    const pins = laps
      .map((l, i) => {
        const isRef = l.lapId === refId;
        const isHovered = l.lapId === this.hoveredLapId;
        return `<button
          type="button"
          class="lap-pin-btn ${isRef ? "is-active" : ""} ${isHovered ? "is-hovered" : ""}"
          data-set-ref="${l.lapId}"
          style="left:${xPct(i).toFixed(2)}%"
          title="${isRef ? `Lap ${l.lapNumber} is the current baseline` : `Use Lap ${l.lapNumber} (${fmtTime(l.lapTimeSec)}) as baseline`}"
          aria-label="Use Lap ${l.lapNumber} as baseline"
        >${icons.target(12)}</button>`;
      })
      .join("");

    // Lap numbers along the bottom, thinned out to stay readable.
    const every = Math.max(1, Math.ceil(laps.length / 20));
    const axis = laps
      .map((l, i) => (i % every === 0 || i === laps.length - 1 ? `<span style="left:${xPct(i).toFixed(2)}%">${l.lapNumber}</span>` : ""))
      .join("");

    return `
      <div class="lap-picker">
        <div class="lap-picker-plot">
          <div class="lap-picker-bars">
            <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="Lap times this session">
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
      <div class="lap-chart-legend">
        <span><i class="lg-review"></i>Reviewing (click bar)</span>
        <span><i class="lg-ref"></i>Baseline (click ${icons.target(11)} under bar or right-click)</span>
        <span><i class="lg-best"></i>Personal best</span>
        <span><i class="lg-line"></i>5-lap average</span>
      </div>`;
  }
}
