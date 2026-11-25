import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { isSlapRFMode, MLModelSummary } from "../types/models";

export interface CrossingDetectorCardOptions {
  readOnly?: () => boolean;
}

/**
 * High-level Track setting card mounted directly inside `ScopedTrackWorkspace`
 * (`Race -> Track` and `Practice -> Track`) outside `TimingRulesEditor`'s per-timer `All timers` scope.
 */
export class CrossingDetectorCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly isReadOnlyFn: () => boolean;
  private lastHtml = "";

  constructor(
    el: HTMLElement,
    store: AppStore,
    api: ApiClient,
    opts: CrossingDetectorCardOptions = {}
  ) {
    super(el);
    this.store = store;
    this.api = api;
    this.isReadOnlyFn = opts.readOnly ?? (() => false);

    this.listen(el, "click", (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const modeBtn = target.closest<HTMLButtonElement>("[data-ml-detector-mode]");
      if (!modeBtn || modeBtn.disabled || this.isReadOnlyFn()) return;

      const nextMode = modeBtn.dataset.mlDetectorMode === "ai" ? "ai" : "classic";
      if (nextMode === "ai") {
        const ready = this.readyTrainedModels();
        if (ready.length === 0) return;
        const curActive = this.store.mlStatus?.config?.activeModelId || "";
        const chosenId = ready.some((m) => m.modelId === curActive)
          ? curActive
          : ready[0].modelId;
        void this.api.updateMLConfig({ detectorMode: "ai", activeModelId: chosenId });
      } else {
        void this.api.updateMLConfig({ detectorMode: "classic" });
      }
    });

    this.listen(el, "change", (e: Event) => {
      if (this.isReadOnlyFn()) return;
      const target = e.target;
      if (target instanceof HTMLSelectElement && target.hasAttribute("data-ml-model-select")) {
        const modelId = target.value;
        if (modelId) {
          void this.api.updateMLConfig({ detectorMode: "ai", activeModelId: modelId });
        }
        return;
      }
      if (target instanceof HTMLInputElement && target.hasAttribute("data-ml-live-tune")) {
        void this.api.updateMLConfig({ liveTuneEnabled: target.checked });
      }
    });

    this.onDispose(
      store.subscribe(["ml", "config", "status", "race", "practice"], () => {
        const active = document.activeElement;
        if (active instanceof HTMLSelectElement && this.el.contains(active)) {
          return;
        }
        this.render();
      })
    );
    this.render();
  }

  private readyTrainedModels(): MLModelSummary[] {
    return (this.store.mlStatus?.models ?? []).filter((m) => !m.builtIn && Boolean(m.ready));
  }

  private render(): void {
    if (!isSlapRFMode(this.store.timingHardwareMode)) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;

    const readOnly = this.isReadOnlyFn();
    const disAttr = readOnly ? "disabled" : "";
    const ml = this.store.mlStatus;
    const ready = this.readyTrainedModels();
    const hasReady = ready.length > 0;
    const isAi = hasReady && ml?.config?.detectorMode === "ai";
    const liveTuneOn = ml?.config?.liveTuneEnabled ?? true;
    const aiBtnDis = disAttr || (!hasReady ? "disabled" : "");

    const activeId = ml?.config?.activeModelId || (hasReady ? ready[0].modelId : "");
    const selectedId =
      hasReady && ready.some((m) => m.modelId === activeId)
        ? activeId
        : hasReady
          ? ready[0].modelId
          : "";

    const optionsHtml = ready
      .map((m) => {
        const sel = m.modelId === selectedId ? "selected" : "";
        const f1Pct = m.aiMetrics ? ` · F1 ${(m.aiMetrics.f1 * 100).toFixed(1)}%` : "";
        return `<option value="${esc(m.modelId)}" ${sel}>${esc(`${m.name}${f1Pct}`)}</option>`;
      })
      .join("");

    const helpText = hasReady
      ? "Switch between Classic Schmitt DSP and your Ready trained models."
      : "Train a model in any Practice → AI Training tab and mark it Ready to select it here.";

    const nextHtml = `
      <div class="track-detector-bar">
        <div class="track-detector-main">
          <div class="track-detector-copy">
            <div class="track-detector-title">
              ${icons.ai(15)}
              <span>Crossing Detector</span>
            </div>
            <p class="note">${esc(helpText)}</p>
          </div>
          <div class="scope-tune-seg detector-mode-seg" role="radiogroup" aria-label="Crossing detector">
            <button
              type="button"
              role="radio"
              aria-checked="${!isAi}"
              class="scope-tune-seg-btn ${!isAi ? "is-active" : ""}"
              data-ml-detector-mode="classic"
              ${disAttr}
            >Classic DSP</button>
            <button
              type="button"
              role="radio"
              aria-checked="${isAi}"
              class="scope-tune-seg-btn ${isAi ? "is-active" : ""}"
              data-ml-detector-mode="ai"
              title="${hasReady ? "Use a Ready trained crossing model" : "Train and mark a model Ready in Practice → AI Training first"}"
              ${aiBtnDis}
            >AI Model</button>
          </div>
        </div>
        ${
          isAi
            ? `<div class="track-detector-subrow">
                 <select class="input rule-detector-select" data-ml-model-select aria-label="Trained AI model" ${disAttr}>
                   ${optionsHtml}
                 </select>
                 <label class="ai-check-label rule-detector-live-tune">
                   <input type="checkbox" data-ml-live-tune ${liveTuneOn ? "checked" : ""} ${disAttr} />
                   <span>Live 2-lap tune</span>
                 </label>
               </div>`
            : ""
        }
      </div>`;

    if (nextHtml !== this.lastHtml) {
      this.lastHtml = nextHtml;
      this.el.innerHTML = nextHtml;
    }
  }
}
