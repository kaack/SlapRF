import { Component } from "../core/component";
import { scanCustomSelects } from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { isSlapRFMode, MLModelSummary } from "../types/models";

export interface CrossingDetectorCardOptions {
  readOnly?: () => boolean;
}

/**
 * Compact single-row Track setting card mounted inside `ScopedTrackWorkspace`
 * (`Race -> Track` and `Practice -> Track`) outside `TimingRulesEditor`.
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
      if (!(target instanceof Element) || this.isReadOnlyFn()) return;

      const tuneBtn = target.closest<HTMLButtonElement>("[data-ml-live-tune-btn]");
      if (tuneBtn && !tuneBtn.disabled) {
        const cur = this.store.mlStatus?.config?.liveTuneEnabled ?? true;
        void this.api.updateMLConfig({ liveTuneEnabled: !cur });
        return;
      }

      const modeBtn = target.closest<HTMLButtonElement>("[data-ml-detector-mode]");
      if (!modeBtn || modeBtn.disabled) return;

      const nextMode = modeBtn.dataset.mlDetectorMode === "ai" ? "ai" : "classic";
      if (nextMode === "ai") {
        const trained = this.trainedModels();
        if (trained.length === 0) return;
        const curActive = this.store.mlStatus?.config?.activeModelId || "";
        const chosenId = trained.some((m) => m.modelId === curActive)
          ? curActive
          : trained[0].modelId;
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

  private trainedModels(): MLModelSummary[] {
    return this.store.mlStatus?.models ?? [];
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
    const trained = this.trainedModels();
    const hasTrained = trained.length > 0;
    const isAi = hasTrained && ml?.config?.detectorMode === "ai";
    const liveTuneOn = ml?.config?.liveTuneEnabled ?? true;
    const aiBtnDis = disAttr || (!hasTrained ? "disabled" : "");

    const activeId = ml?.config?.activeModelId || (hasTrained ? trained[0].modelId : "");
    const selectedId =
      hasTrained && trained.some((m) => m.modelId === activeId)
        ? activeId
        : hasTrained
          ? trained[0].modelId
          : "";

    const optionsHtml = trained
      .map((m) => {
        const sel = m.modelId === selectedId ? "selected" : "";
        const lbl = m.builtIn ? `${m.name} (1P)` : m.name;
        return `<option value="${esc(m.modelId)}" ${sel}>${esc(lbl)}</option>`;
      })
      .join("");

    const aiTitle = hasTrained
      ? "Use a trained AI crossing model"
      : "Train a model in Practice → AI first";

    const nextHtml = `
      <div class="track-detector-bar ${isAi ? "is-ai-active" : ""}">
        <div class="track-detector-title" title="${esc(aiTitle)}">
          ${icons.ai(15)}
          <span class="track-detector-label-full">Crossing detector</span>
          <span class="track-detector-label-short">${isAi ? "Detector" : "Crossing detector"}</span>
        </div>
        <div class="track-detector-controls">
          ${
            isAi
              ? `<select class="input rule-detector-select" data-ml-model-select aria-label="Trained AI model" ${disAttr}>
                   ${optionsHtml}
                 </select>
                 <button
                   type="button"
                   class="scope-tune-seg-btn track-detector-tune-btn ${liveTuneOn ? "is-active" : ""}"
                   data-ml-live-tune-btn
                   aria-pressed="${liveTuneOn ? "true" : "false"}"
                   title="Live 2-lap per-timer fine-tuning (${liveTuneOn ? "On" : "Off"})"
                   ${disAttr}
                 >2L Tune</button>`
              : ""
          }
          <div class="scope-tune-seg detector-mode-seg" role="radiogroup" aria-label="Crossing detector">
            <button
              type="button"
              role="radio"
              aria-checked="${!isAi}"
              class="scope-tune-seg-btn ${!isAi ? "is-active" : ""}"
              data-ml-detector-mode="classic"
              ${disAttr}
            >DSP</button>
            <button
              type="button"
              role="radio"
              aria-checked="${isAi}"
              class="scope-tune-seg-btn ${isAi ? "is-active" : ""}"
              data-ml-detector-mode="ai"
              title="${esc(aiTitle)}"
              ${aiBtnDis}
            >AI</button>
          </div>
        </div>
      </div>`;

    if (nextHtml !== this.lastHtml) {
      this.lastHtml = nextHtml;
      this.el.innerHTML = nextHtml;
      scanCustomSelects(this.el);
    }
  }
}
