import { Component } from "../../core/component";
import { scanCustomSelects } from "../../core/custom_select";
import { esc } from "../../core/format";
import { icons } from "../../core/icons";
import { ApiClient } from "../../services/api_client";
import { AppStore } from "../../state/store";
import { MLModelSummary, PracticeSession } from "../../types/models";

function countValidPasses(s: PracticeSession): number {
  return (s.crossings ?? []).filter((c) => !c.invalidReason || c.manual).length;
}

function countValidLaps(s: PracticeSession): number {
  return (s.laps ?? []).filter((l) => !l.invalidated).length;
}

type AITrainMode = "new" | "finetune";

/**
 * Clean, explicit `AI` training tab inside each Practice session (`#/practice/<session>/ai`):
 * - **New Model**: Train a brand-new model from scratch using this practice's data (plus other practices if checked).
 * - **Fine-Tune**: Pick an existing model and fine-tune it with this practice's new data.
 * - Mark Ready -> available in Race & Practice `Track`.
 */
export class PracticeAITrainingTab extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onOpenTab: (tab: "review" | "signals" | "track") => void;

  private lastSessionId = "";
  private trainMode: AITrainMode | null = null;
  private newModelNameDraft = "";
  private includeOthersForNew = true;
  private includeOthersForFineTune = false;
  private selectedModelId = "";
  private lastCompletedId = "";
  private startingTraining = false;
  private startingEpochs = 28;
  private lastRenderSig = "";
  private statusMsg = "";
  private errorMsg = "";

  constructor(
    el: HTMLElement,
    store: AppStore,
    api: ApiClient,
    onOpenTab: (tab: "review" | "signals" | "track") => void
  ) {
    super(el);
    this.store = store;
    this.api = api;
    this.onOpenTab = onOpenTab;

    this.listen(el, "click", this.handleClick);
    this.listen(el, "change", this.handleChange);
    this.listen(el, "input", this.handleInput);

    this.onDispose(
      store.subscribe(["practice", "ml", "config", "laps", "crossings"], () => {
        const active = document.activeElement;
        if (
          active instanceof HTMLInputElement &&
          this.el.contains(active) &&
          active.hasAttribute("data-ai-model-name")
        ) {
          return;
        }
        this.render();
      })
    );
    void this.api.fetchMLStatus().catch(() => undefined);
    this.render(true);
  }

  public onActivate(): void {
    void this.api.fetchMLStatus().catch(() => undefined);
    this.render(true);
  }

  private otherRecordedSessions(currentId: string): PracticeSession[] {
    return this.store.practiceSessions.filter(
      (s) =>
        s.sessionId !== currentId &&
        ((s.traceSampleCount ?? 0) > 0 || s.crossings.length > 0 || s.laps.length > 0)
    );
  }

  private customModels(): MLModelSummary[] {
    return (this.store.mlStatus.models ?? []).filter((m) => !m.builtIn);
  }

  private defaultNewModelName(sess: PracticeSession | undefined): string {
    const base = sess?.name?.trim() || "Practice";
    const models = this.customModels();
    if (!models.some((m) => m.name.toLowerCase() === base.toLowerCase())) {
      return base;
    }
    let idx = 2;
    while (models.some((m) => m.name.toLowerCase() === `${base} v${idx}`.toLowerCase())) {
      idx++;
    }
    return `${base} v${idx}`;
  }

  private resolveSelectedModel(sess: PracticeSession | undefined): MLModelSummary | null {
    const models = this.customModels();
    if (models.length === 0) return null;
    if (this.selectedModelId) {
      const m = models.find((x) => x.modelId === this.selectedModelId);
      if (m) return m;
    }
    const completedId = this.store.mlStatus.training.completedModelId;
    if (completedId) {
      const m = models.find((x) => x.modelId === completedId);
      if (m) return m;
    }
    if (sess) {
      const fromSess = models.find((x) => (x.sourceSessionIds ?? []).includes(sess.sessionId));
      if (fromSess) return fromSess;
    }
    const activeId = this.store.mlStatus.config.activeModelId;
    if (activeId) {
      const m = models.find((x) => x.modelId === activeId);
      if (m) return m;
    }
    return models[0] ?? null;
  }

  private resolveTrainMode(sess: PracticeSession | undefined): AITrainMode {
    const models = this.customModels();
    if (models.length === 0) return "new";
    if (this.trainMode) return this.trainMode;
    if (
      sess &&
      models.some(
        (x) =>
          (x.sourceSessionIds ?? []).includes(sess.sessionId) ||
          x.modelId === this.store.mlStatus.training.completedModelId
      )
    ) {
      return "finetune";
    }
    return "new";
  }

  private computeSig(): string {
    const sess = this.store.selectedPracticeSession;
    const ml = this.store.mlStatus;
    const others = this.otherRecordedSessions(sess?.sessionId ?? "");
    const mode = this.resolveTrainMode(sess);
    const modelsSig = this.customModels()
      .map(
        (m) =>
          `${m.modelId}:${m.name}:${m.ready ? 1 : 0}:${m.epochsTrained ?? 0}:${m.aiMetrics?.f1 ?? 0}:${m.finalLoss}`
      )
      .join("|");
    return [
      sess?.sessionId ?? "",
      sess?.name ?? "",
      sess?.laps.length ?? 0,
      sess?.crossings.length ?? 0,
      others.length,
      others.reduce((sum, s) => sum + countValidPasses(s), 0),
      mode,
      this.includeOthersForNew ? 1 : 0,
      this.includeOthersForFineTune ? 1 : 0,
      this.selectedModelId,
      this.startingTraining ? 1 : 0,
      this.startingEpochs,
      ml.config.detectorMode,
      ml.config.activeModelId,
      ml.training.running ? 1 : 0,
      ml.training.epoch,
      ml.training.totalEpochs,
      ml.training.loss,
      ml.training.message ?? "",
      ml.training.completedModelId ?? "",
      modelsSig,
      this.statusMsg,
      this.errorMsg,
    ].join("::");
  }

  public render(force = false): void {
    const sess = this.store.selectedPracticeSession;
    if (this.store.mlStatus.training.running && this.startingTraining) {
      this.startingTraining = false;
    }
    const completedId = this.store.mlStatus.training.completedModelId || "";
    if (completedId && completedId !== this.lastCompletedId) {
      this.lastCompletedId = completedId;
      if (this.customModels().some((m) => m.modelId === completedId)) {
        this.selectedModelId = completedId;
        this.trainMode = "finetune";
      }
    }

    if (sess && sess.sessionId !== this.lastSessionId) {
      this.lastSessionId = sess.sessionId;
      this.trainMode = null;
      this.selectedModelId = "";
      this.newModelNameDraft = this.defaultNewModelName(sess);
    } else if (!this.newModelNameDraft && sess) {
      this.newModelNameDraft = this.defaultNewModelName(sess);
    }

    const sig = this.computeSig();
    if (!force && sig === this.lastRenderSig) {
      return;
    }
    this.lastRenderSig = sig;

    if (!sess) {
      this.el.innerHTML = "";
      return;
    }

    const ml = this.store.mlStatus;
    const customModels = this.customModels();
    const mode = this.resolveTrainMode(sess);
    const curLaps = countValidLaps(sess);
    const curPasses = countValidPasses(sess);
    const others = this.otherRecordedSessions(sess.sessionId);
    const otherPasses = others.reduce((sum, s) => sum + countValidPasses(s), 0);
    const includeOthers = mode === "new" ? this.includeOthersForNew : this.includeOthersForFineTune;
    const totalPasses = curPasses + (includeOthers ? otherPasses : 0);

    const selectedModel = this.resolveSelectedModel(sess);
    if (selectedModel && !this.selectedModelId) {
      this.selectedModelId = selectedModel.modelId;
    }

    const isBusy = this.startingTraining || ml.training.running;
    const effTotalEpochs =
      ml.training.running && ml.training.totalEpochs > 0
        ? ml.training.totalEpochs
        : this.startingEpochs;
    const effEpoch = ml.training.running ? ml.training.epoch : 0;
    const trainPct = isBusy
      ? effEpoch > 0 && effTotalEpochs > 0
        ? Math.min(100, Math.round((effEpoch / effTotalEpochs) * 100))
        : 6
      : 0;

    const alertsHtml = `
      ${this.errorMsg ? `<div class="ai-train-banner is-error" role="alert">${esc(this.errorMsg)}</div>` : ""}
      ${this.statusMsg ? `<div class="ai-train-banner is-ok" role="status">${esc(this.statusMsg)}</div>` : ""}`;

    const modeTabsHtml =
      customModels.length > 0
        ? `<div class="segmented ai-mode-seg" role="tablist" aria-label="Training mode">
             <button
               type="button"
               role="tab"
               aria-selected="${mode === "new" ? "true" : "false"}"
               class="${mode === "new" ? "is-active" : ""}"
               data-ai-train-mode="new"
               ${isBusy ? "disabled" : ""}
             >New Model</button>
             <button
               type="button"
               role="tab"
               aria-selected="${mode === "finetune" ? "true" : "false"}"
               class="${mode === "finetune" ? "is-active" : ""}"
               data-ai-train-mode="finetune"
               ${isBusy ? "disabled" : ""}
             >Fine-Tune</button>
           </div>`
        : "";

    const controlsRowHtml =
      mode === "finetune" && customModels.length > 0
        ? `<div class="ai-train-controls-row">
             <select class="input ai-finetune-select" data-ai-finetune-select aria-label="Model to fine-tune" ${isBusy ? "disabled" : ""}>
               ${customModels
                 .map(
                   (m) =>
                     `<option value="${esc(m.modelId)}" ${selectedModel?.modelId === m.modelId ? "selected" : ""}>${esc(m.name)} (${(m.aiMetrics.f1 * 100).toFixed(0)}%)</option>`
                 )
                 .join("")}
             </select>
             <button
               type="button"
               class="btn btn-sm"
               data-ai-act="train-more"
               data-model-id="${esc(selectedModel?.modelId ?? customModels[0].modelId)}"
               ${isBusy ? "disabled" : ""}
             >${isBusy ? "Training…" : "Fine-Tune"}</button>
           </div>`
        : `<div class="ai-train-controls-row">
             <input
               type="text"
               class="input ai-name-input"
               data-ai-model-name
               aria-label="New model name"
               value="${esc(this.newModelNameDraft)}"
               placeholder="New model name"
               ${isBusy ? "disabled" : ""}
             />
             <button
               type="button"
               class="btn btn-sm"
               data-ai-act="train-fresh"
               ${isBusy ? "disabled" : ""}
             >${isBusy ? "Training…" : "Train"}</button>
           </div>`;

    const shownScorecardModel = mode === "finetune" ? selectedModel : null;
    const isScorecardActive = Boolean(
      shownScorecardModel &&
        ml.config.detectorMode === "ai" &&
        ml.config.activeModelId === shownScorecardModel.modelId
    );
    const scorecardHtml = shownScorecardModel
      ? `
        <div class="ai-scorecard-box">
          <div class="ai-scorecard-head">
            <div class="ai-scorecard-title-wrap">
              <strong class="ai-model-name">${esc(shownScorecardModel.name)}</strong>
              <span class="note mono">${shownScorecardModel.epochsTrained ?? 28}ep</span>
            </div>
            ${
              isScorecardActive
                ? `<span class="scope-ai-chip">Active</span>`
                : `<button
                     type="button"
                     class="btn btn-ghost btn-xs ai-model-use-btn"
                     data-ai-act="use-model"
                     data-model-id="${esc(shownScorecardModel.modelId)}"
                   >Use</button>`
            }
          </div>
          <div class="table-scroll">
            <table class="table rc-compact-table ai-scorecard-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>DSP</th>
                  <th>AI</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Passes found</td>
                  <td class="mono">${shownScorecardModel.classicMetrics.detectedPasses} / ${shownScorecardModel.classicMetrics.totalPasses}</td>
                  <td class="mono"><strong>${shownScorecardModel.aiMetrics.detectedPasses} / ${shownScorecardModel.aiMetrics.totalPasses}</strong></td>
                </tr>
                <tr>
                  <td>False triggers</td>
                  <td class="mono">${shownScorecardModel.classicMetrics.falseTriggers}</td>
                  <td class="mono"><strong>${shownScorecardModel.aiMetrics.falseTriggers}</strong></td>
                </tr>
                <tr>
                  <td>Accuracy</td>
                  <td class="mono">${(shownScorecardModel.classicMetrics.f1 * 100).toFixed(1)}%</td>
                  <td class="mono"><strong>${(shownScorecardModel.aiMetrics.f1 * 100).toFixed(1)}%</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>`
      : "";

    const savedModelsHtml =
      customModels.length > 0
        ? `
        <div class="card ai-train-card">
          <div class="ai-scorecard-head">
            <h3 class="ai-card-title">Models</h3>
            <div class="ai-model-row-actions">
              <button type="button" class="btn btn-ghost btn-xs ai-model-use-btn" data-ai-act="export-dataset">Export</button>
              <label class="btn btn-ghost btn-xs ai-model-use-btn ai-import-label">
                <span>Import</span>
                <input type="file" accept=".gz,.tgz,application/gzip" data-ai-import-file hidden />
              </label>
            </div>
          </div>
          <div class="ai-model-list">
            ${customModels
              .map((m) => {
                const isActive =
                  ml.config.detectorMode === "ai" && ml.config.activeModelId === m.modelId;
                return `
                  <div class="ai-model-row ${isActive ? "is-active" : ""}">
                    <button
                      type="button"
                      class="ai-model-main"
                      data-ai-act="focus-model"
                      data-model-id="${esc(m.modelId)}"
                    >
                      <span class="ai-model-name">${esc(m.name)}</span>
                      <span class="ai-model-stats mono">${(m.aiMetrics.f1 * 100).toFixed(0)}% · ${m.epochsTrained ?? 28}ep</span>
                    </button>
                    <div class="ai-model-row-actions">
                      ${
                        isActive
                          ? `<span class="scope-ai-chip">Active</span>`
                          : `<button
                               type="button"
                               class="btn btn-ghost btn-xs ai-model-use-btn"
                               data-ai-act="use-model"
                               data-model-id="${esc(m.modelId)}"
                             >Use</button>`
                      }
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs ai-model-del-btn"
                        data-ai-act="delete-model"
                        data-model-id="${esc(m.modelId)}"
                        title="Delete ${esc(m.name)}"
                        aria-label="Delete ${esc(m.name)}"
                      >${icons.trash(13)}</button>
                    </div>
                  </div>`;
              })
              .join("")}
          </div>
        </div>`
        : "";

    this.el.innerHTML = `
      <div class="ai-train-stack">
        ${alertsHtml}

        <div class="card ai-train-card">
          <div class="ai-scorecard-head">
            <span class="badge mono">${curLaps} laps · ${curPasses} passes</span>
            <button type="button" class="btn btn-ghost btn-xs" data-ai-act="open-review">
              ${icons.reviewCheck(14)}<span>Review Laps</span>
            </button>
          </div>

          ${modeTabsHtml}

          ${
            others.length > 0
              ? `<label class="ai-check-label">
                   <input type="checkbox" data-ai-include-others ${includeOthers ? "checked" : ""} ${isBusy ? "disabled" : ""} />
                   <span>Include ${others.length} other practice${others.length === 1 ? "" : "s"} (${totalPasses} passes total)</span>
                 </label>`
              : ""
          }

          ${controlsRowHtml}

          ${
            isBusy
              ? `<div class="ai-train-progress-wrap" data-ai-progress>
                   <div class="ai-train-progress-text">
                     <span>${effEpoch > 0 ? `Epoch ${effEpoch} / ${effTotalEpochs}` : "Preparing training data…"}</span>
                     <span class="mono">${effEpoch > 0 ? `loss ${ml.training.loss.toFixed(4)}` : `0 / ${effTotalEpochs}`}</span>
                   </div>
                   <div class="ai-progress-track">
                     <div class="ai-progress-fill" style="width:${trainPct}%"></div>
                   </div>
                 </div>`
              : ""
          }

          ${scorecardHtml}
        </div>

        ${savedModelsHtml}
      </div>`;

    scanCustomSelects(this.el);
  }

  private selectedSessionIds(mode: AITrainMode): string[] {
    const sess = this.store.selectedPracticeSession;
    if (!sess) return [];
    const includeOthers = mode === "new" ? this.includeOthersForNew : this.includeOthersForFineTune;
    if (!includeOthers) {
      return [sess.sessionId];
    }
    const others = this.otherRecordedSessions(sess.sessionId).map((s) => s.sessionId);
    return [sess.sessionId, ...others];
  }

  private readonly handleInput = (e: Event): void => {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-model-name")) {
      this.newModelNameDraft = target.value;
    }
  };

  private readonly handleChange = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-include-others")) {
      const mode = this.resolveTrainMode(this.store.selectedPracticeSession);
      if (mode === "new") {
        this.includeOthersForNew = target.checked;
      } else {
        this.includeOthersForFineTune = target.checked;
      }
      this.render(true);
      return;
    }

    if (target instanceof HTMLSelectElement && target.hasAttribute("data-ai-finetune-select")) {
      this.selectedModelId = target.value;
      this.render(true);
      return;
    }

    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-import-file")) {
      const file = target.files?.[0];
      target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result;
        if (!(res instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(res);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const b64 = window.btoa(binary);
        void this.api
          .importMLDatasetArchive(b64)
          .then((imp) => {
            this.statusMsg = `Imported ${imp.importedSessions} session(s) and ${imp.importedModels} model(s).`;
            void this.api.fetchMLStatus().catch(() => undefined);
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
      };
      reader.readAsArrayBuffer(file);
    }
  };

  private readonly handleClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const modeBtn = target.closest<HTMLButtonElement>("[data-ai-train-mode]");
    if (modeBtn) {
      const next = modeBtn.dataset.aiTrainMode === "finetune" ? "finetune" : "new";
      this.trainMode = next;
      if (next === "new" && !this.newModelNameDraft.trim()) {
        this.newModelNameDraft = this.defaultNewModelName(this.store.selectedPracticeSession);
      }
      this.render(true);
      return;
    }

    const btn = target.closest<HTMLElement>("[data-ai-act]");
    if (!btn || (btn instanceof HTMLButtonElement && btn.disabled)) return;

    const act = btn.dataset.aiAct;
    this.errorMsg = "";

    switch (act) {
      case "open-review":
        this.onOpenTab("review");
        break;

      case "open-track":
        this.onOpenTab("track");
        break;

      case "focus-model": {
        const id = btn.dataset.modelId || "";
        const mod = this.customModels().find((m) => m.modelId === id);
        if (mod) {
          this.selectedModelId = mod.modelId;
          this.trainMode = "finetune";
          this.render(true);
        }
        break;
      }

      case "train-fresh": {
        if (this.startingTraining || this.store.mlStatus.training.running) return;
        this.statusMsg = "";
        const sess = this.store.selectedPracticeSession;
        const cleanName = this.newModelNameDraft.trim() || this.defaultNewModelName(sess);
        this.startingTraining = true;
        this.startingEpochs = 28;
        this.render(true);
        void this.api
          .startMLTraining({
            epochs: 28,
            includeUnverified: true,
            sessionIds: this.selectedSessionIds("new"),
            modelName: cleanName,
          })
          .then((st) => {
            this.newModelNameDraft = "";
            if (!st?.training?.running) {
              this.startingTraining = false;
              this.render(true);
            }
          })
          .catch((err: unknown) => {
            this.startingTraining = false;
            this.setErr(err);
          });
        break;
      }

      case "train-more": {
        if (this.startingTraining || this.store.mlStatus.training.running) return;
        this.statusMsg = "";
        const modelId =
          btn.dataset.modelId ||
          this.resolveSelectedModel(this.store.selectedPracticeSession)?.modelId ||
          "";
        if (!modelId) return;
        this.selectedModelId = modelId;
        this.startingTraining = true;
        this.startingEpochs = 20;
        this.render(true);
        void this.api
          .startMLTraining({
            epochs: 20,
            includeUnverified: true,
            sessionIds: this.selectedSessionIds("finetune"),
            continueModelId: modelId,
          })
          .then((st) => {
            if (!st?.training?.running) {
              this.startingTraining = false;
              this.render(true);
            }
          })
          .catch((err: unknown) => {
            this.startingTraining = false;
            this.setErr(err);
          });
        break;
      }

      case "use-model": {
        const modelId = btn.dataset.modelId || "";
        const mod = this.customModels().find((m) => m.modelId === modelId);
        if (!mod) return;
        this.selectedModelId = mod.modelId;
        void this.api
          .updateMLConfig({ detectorMode: "ai", activeModelId: mod.modelId })
          .then(() => {
            this.statusMsg = "";
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }

      case "delete-model": {
        const modelId = btn.dataset.modelId || "";
        if (!modelId) return;
        if (this.selectedModelId === modelId) {
          this.selectedModelId = "";
        }
        void this.api
          .deleteMLModel(modelId)
          .then(() => {
            this.statusMsg = "";
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }

      case "export-dataset": {
        void this.api
          .exportMLDatasetArchive()
          .then((res) => {
            const bin = window.atob(res.archiveB64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
              bytes[i] = bin.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: "application/gzip" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = res.filename || "slaprf-ai-dataset.tar.gz";
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
    }
  };

  private setErr(err: unknown): void {
    this.errorMsg = err instanceof Error ? err.message : String(err);
    this.render(true);
  }
}
