import { Component } from "../../core/component";
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

function isTrainedModel(m: MLModelSummary): boolean {
  return Boolean(m.builtIn || (m.epochsTrained ?? 0) > 0);
}

/**
 * `AI Training` tab inside each Practice session (`#/practice/<session>/ai`):
 * 1. Top card (matching `Pilots`): Search / `+ Add` bar + top-5 scrollable `Models` list (`1P` + custom trained/untrained).
 * 2. Bottom card: Context-aware training box whose action & content adapt to the selected model:
 *    - **Untrained model** -> `Train` (trains from scratch into that model's immutable ID).
 *    - **Trained model** -> `Fine-Tune` + compact `DSP` vs `AI` metrics table.
 */
export class PracticeAITrainingTab extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onOpenTab: (tab: "review" | "signals" | "track") => void;

  private lastSessionId = "";
  private searchQuery = "";
  private selectedModelId = "";
  private editingModelName = false;
  private renameDraft = "";
  private pendingFocusRename = false;
  private includeOthersForNew = true;
  private includeOthersForFineTune = false;
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
    this.listen(el, "keydown", this.handleKeyDown);
    this.listen(el, "focusout", this.handleFocusOut);

    this.onDispose(
      store.subscribe(["practice", "ml", "config", "laps", "crossings"], () => {
        const active = document.activeElement;
        if (
          active instanceof HTMLInputElement &&
          this.el.contains(active) &&
          (active.hasAttribute("data-ai-search-input") ||
            active.hasAttribute("data-ai-rename-input"))
        ) {
          if (active.hasAttribute("data-ai-search-input")) {
            this.syncSearchResultsInPlace();
          }
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

  private allModels(): MLModelSummary[] {
    return this.store.mlStatus.models ?? [];
  }

  private filteredModels(): MLModelSummary[] {
    const q = this.searchQuery.trim().toLowerCase();
    const all = this.allModels();
    if (!q) return all;
    return all.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.builtIn && "1p".includes(q)) ||
        (!isTrainedModel(m) && "untrained".includes(q))
    );
  }

  private canCreateFromSearch(): boolean {
    const q = this.searchQuery.trim();
    if (!q) return false;
    const lower = q.toLowerCase();
    return !this.allModels().some((m) => m.name.trim().toLowerCase() === lower);
  }

  private resolveSelectedModel(sess: PracticeSession | undefined): MLModelSummary | null {
    const models = this.allModels();
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

  private computeSig(): string {
    const sess = this.store.selectedPracticeSession;
    const ml = this.store.mlStatus;
    const others = this.otherRecordedSessions(sess?.sessionId ?? "");
    const modelsSig = this.allModels()
      .map(
        (m) =>
          `${m.modelId}:${m.name}:${m.builtIn ? 1 : 0}:${m.epochsTrained ?? 0}:${m.aiMetrics?.f1 ?? 0}:${m.finalLoss}`
      )
      .join("|");
    return [
      sess?.sessionId ?? "",
      sess?.name ?? "",
      sess?.laps.length ?? 0,
      sess?.crossings.length ?? 0,
      others.length,
      others.reduce((sum, s) => sum + countValidPasses(s), 0),
      this.searchQuery,
      this.includeOthersForNew ? 1 : 0,
      this.includeOthersForFineTune ? 1 : 0,
      this.selectedModelId,
      this.editingModelName ? 1 : 0,
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

  private renderModelsListItemsHtml(selectedId: string): string {
    const ml = this.store.mlStatus;
    const filtered = this.filteredModels();
    if (filtered.length === 0) {
      return `<div class="ai-model-empty note">No matching models. Tap <strong>+ Add</strong> above to create "${esc(this.searchQuery.trim())}".</div>`;
    }
    return filtered
      .map((m) => {
        const isActive = ml.config.detectorMode === "ai" && ml.config.activeModelId === m.modelId;
        const isSelected = selectedId === m.modelId;
        const trained = isTrainedModel(m);
        return `
          <div class="ai-model-row ${isSelected ? "is-selected" : ""}">
            <button
              type="button"
              class="ai-model-main"
              data-ai-act="focus-model"
              data-model-id="${esc(m.modelId)}"
            >
              <span class="ai-model-name">${esc(m.name)}</span>
              ${m.builtIn ? `<span class="ai-1p-badge" title="Shipped 1P model">1P</span>` : ""}
              ${
                trained
                  ? `<span class="ai-model-stats mono">${(m.aiMetrics.f1 * 100).toFixed(0)}% · ${m.epochsTrained || 18}ep</span>`
                  : `<span class="ai-model-stats is-untrained">Untrained</span>`
              }
            </button>
            <div class="ai-model-row-actions">
              ${isActive ? `<span class="scope-ai-chip">Active</span>` : ""}
              ${
                m.builtIn
                  ? ""
                  : `<button
                       type="button"
                       class="btn btn-ghost btn-xs ai-model-del-btn"
                       data-ai-act="delete-model"
                       data-model-id="${esc(m.modelId)}"
                       title="Delete ${esc(m.name)}"
                       aria-label="Delete ${esc(m.name)}"
                     >${icons.trash(13)}</button>`
              }
            </div>
          </div>`;
      })
      .join("");
  }

  private syncSearchResultsInPlace(): void {
    const sess = this.store.selectedPracticeSession;
    const selectedModel = this.resolveSelectedModel(sess);
    const listHost = this.el.querySelector<HTMLElement>("[data-ai-models-list-host]");
    if (listHost) {
      listHost.innerHTML = this.renderModelsListItemsHtml(selectedModel?.modelId ?? "");
    }
    const addBtn = this.el.querySelector<HTMLButtonElement>('[data-ai-act="create-model"]');
    const isBusy = this.startingTraining || this.store.mlStatus.training.running;
    if (addBtn) {
      addBtn.disabled = isBusy || !this.canCreateFromSearch();
    }
    this.lastRenderSig = this.computeSig();
  }

  public render(force = false): void {
    const sess = this.store.selectedPracticeSession;
    if (this.store.mlStatus.training.running && this.startingTraining) {
      this.startingTraining = false;
    }
    const completedId = this.store.mlStatus.training.completedModelId || "";
    if (completedId && completedId !== this.lastCompletedId) {
      this.lastCompletedId = completedId;
      if (this.allModels().some((m) => m.modelId === completedId)) {
        this.selectedModelId = completedId;
      }
    }

    if (sess && sess.sessionId !== this.lastSessionId) {
      this.lastSessionId = sess.sessionId;
      this.selectedModelId = "";
      this.searchQuery = "";
      this.editingModelName = false;
      this.renameDraft = "";
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
    const curLaps = countValidLaps(sess);
    const curPasses = countValidPasses(sess);
    const others = this.otherRecordedSessions(sess.sessionId);
    const otherPasses = others.reduce((sum, s) => sum + countValidPasses(s), 0);

    const selectedModel = this.resolveSelectedModel(sess);
    if (selectedModel && !this.selectedModelId) {
      this.selectedModelId = selectedModel.modelId;
    }
    const selectedTrained = selectedModel ? isTrainedModel(selectedModel) : false;
    const includeOthers = selectedTrained ? this.includeOthersForFineTune : this.includeOthersForNew;
    const totalPasses = curPasses + (includeOthers ? otherPasses : 0);

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

    const canCreate = this.canCreateFromSearch();
    const modelsCardHtml = `
      <div class="card card-flush ai-models-card">
        <div class="rc-pilots-search-bar practice-pop-search-bar ai-models-search-bar">
          <div class="rc-pilots-search-row">
            ${icons.search(13)}
            <input
              type="search"
              class="input input-sm rc-pilots-search-input"
              data-ai-search-input
              value="${esc(this.searchQuery)}"
              placeholder="Search or add model..."
              maxlength="64"
              autocomplete="off"
              aria-label="Search or add model"
            />
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-xs bkt-pilots-add-btn"
            data-ai-act="create-model"
            ${canCreate && !isBusy ? "" : "disabled"}
            title="Add new untrained model"
          >
            ${icons.plus(12)}<span>Add</span>
          </button>
        </div>
        <div class="ai-model-list is-top-scrollable" data-ai-models-list-host>
          ${this.renderModelsListItemsHtml(selectedModel?.modelId ?? "")}
        </div>
      </div>`;

    const trainingBoxHtml = selectedModel
      ? `
      <div class="card ai-train-card" data-ai-training-box data-model-state="${selectedTrained ? "trained" : "untrained"}">
        <div class="ai-scorecard-head">
          <span class="badge mono">${curLaps} laps · ${curPasses} passes</span>
          <button type="button" class="btn btn-ghost btn-xs" data-ai-act="open-review">
            ${icons.reviewCheck(14)}<span>Review Laps</span>
          </button>
        </div>

        ${
          others.length > 0
            ? `<label class="ai-check-label">
                 <input type="checkbox" data-ai-include-others ${includeOthers ? "checked" : ""} ${isBusy ? "disabled" : ""} />
                 <span>Include ${others.length} other practice${others.length === 1 ? "" : "s"} (${totalPasses} passes total)</span>
               </label>`
            : ""
        }

        <div class="ai-train-controls-row">
          ${
            this.editingModelName && !selectedModel.builtIn
              ? `<input
                   type="text"
                   class="input ai-name-input"
                   data-ai-rename-input
                   data-model-id="${esc(selectedModel.modelId)}"
                   aria-label="Edit model name"
                   value="${esc(this.renameDraft)}"
                   maxlength="64"
                 />`
              : `<div class="ai-name-readonly-field" data-ai-readonly-field>
                   <span class="ai-name-readonly-text">${esc(selectedModel.name)}</span>
                   ${
                     selectedModel.builtIn
                       ? `<span class="ai-1p-badge" title="Shipped 1P model">1P</span>`
                       : `<button
                            type="button"
                            class="ai-name-pencil-btn"
                            data-ai-act="edit-model-name"
                            data-model-id="${esc(selectedModel.modelId)}"
                            title="Rename model"
                            aria-label="Rename model"
                            ${isBusy ? "disabled" : ""}
                          >${icons.pencil(13)}</button>`
                   }
                 </div>`
          }
          ${
            selectedTrained
              ? `<button
                   type="button"
                   class="btn btn-sm"
                   data-ai-act="train-more"
                   data-model-id="${esc(selectedModel.modelId)}"
                   ${isBusy ? "disabled" : ""}
                 >${isBusy ? "Training…" : "Fine-Tune"}</button>`
              : `<button
                   type="button"
                   class="btn btn-sm"
                   data-ai-act="train-fresh"
                   data-model-id="${esc(selectedModel.modelId)}"
                   ${isBusy ? "disabled" : ""}
                 >${isBusy ? "Training…" : "Train"}</button>`
          }
        </div>

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

        ${
          selectedTrained
            ? `<div class="ai-scorecard-box">
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
                         <td class="mono">${selectedModel.classicMetrics.detectedPasses} / ${selectedModel.classicMetrics.totalPasses}</td>
                         <td class="mono"><strong>${selectedModel.aiMetrics.detectedPasses} / ${selectedModel.aiMetrics.totalPasses}</strong></td>
                       </tr>
                       <tr>
                         <td>False triggers</td>
                         <td class="mono">${selectedModel.classicMetrics.falseTriggers}</td>
                         <td class="mono"><strong>${selectedModel.aiMetrics.falseTriggers}</strong></td>
                       </tr>
                       <tr>
                         <td>Accuracy</td>
                         <td class="mono">${(selectedModel.classicMetrics.f1 * 100).toFixed(1)}%</td>
                         <td class="mono"><strong>${(selectedModel.aiMetrics.f1 * 100).toFixed(1)}%</strong></td>
                       </tr>
                     </tbody>
                   </table>
                 </div>
               </div>`
            : `<div class="ai-untrained-note note">Untrained model — tap <strong>Train</strong> to build it from this practice.</div>`
        }
      </div>`
      : "";

    this.el.innerHTML = `
      <div class="ai-train-stack">
        ${alertsHtml}
        ${modelsCardHtml}
        ${trainingBoxHtml}
        <div class="ai-bundle-footer">
          <button type="button" class="btn btn-ghost btn-xs ai-model-use-btn" data-ai-act="export-dataset">Export Bundle</button>
          <label class="btn btn-ghost btn-xs ai-model-use-btn ai-import-label">
            <span>Import Bundle</span>
            <input type="file" accept=".gz,.tgz,application/gzip" data-ai-import-file hidden />
          </label>
        </div>
      </div>`;

    if (this.pendingFocusRename) {
      this.pendingFocusRename = false;
      const inp = this.el.querySelector<HTMLInputElement>("[data-ai-rename-input]");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }

  private selectedSessionIds(forTrainedModel: boolean): string[] {
    const sess = this.store.selectedPracticeSession;
    if (!sess) return [];
    const includeOthers = forTrainedModel ? this.includeOthersForFineTune : this.includeOthersForNew;
    if (!includeOthers) {
      return [sess.sessionId];
    }
    const others = this.otherRecordedSessions(sess.sessionId).map((s) => s.sessionId);
    return [sess.sessionId, ...others];
  }

  private createModelFromQuery(): void {
    if (this.startingTraining || this.store.mlStatus.training.running) return;
    const cleanName = this.searchQuery.trim();
    if (!cleanName || !this.canCreateFromSearch()) return;
    this.errorMsg = "";
    this.statusMsg = "";
    void this.api
      .createMLModel(cleanName)
      .then((st) => {
        const created = (st?.models ?? []).find(
          (m) => m.name.trim().toLowerCase() === cleanName.toLowerCase()
        );
        this.searchQuery = "";
        this.editingModelName = false;
        if (created) {
          this.selectedModelId = created.modelId;
        }
        this.render(true);
      })
      .catch((err: unknown) => this.setErr(err));
  }

  private readonly handleInput = (e: Event): void => {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-search-input")) {
      this.searchQuery = target.value;
      this.syncSearchResultsInPlace();
    } else if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-rename-input")) {
      this.renameDraft = target.value;
    }
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.hasAttribute("data-ai-search-input")) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (this.canCreateFromSearch()) {
          this.createModelFromQuery();
        } else {
          const first = this.filteredModels()[0];
          if (first) {
            this.selectedModelId = first.modelId;
            this.searchQuery = "";
            this.render(true);
          }
        }
      }
      return;
    }

    if (target.hasAttribute("data-ai-rename-input")) {
      if (e.key === "Enter") {
        e.preventDefault();
        target.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.editingModelName = false;
        this.renameDraft = "";
        this.render(true);
      }
    }
  };

  private readonly handleFocusOut = (e: FocusEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-ai-rename-input")) {
      return;
    }
    if (!this.editingModelName) return;
    const modelId = target.dataset.modelId || "";
    this.commitModelRename(modelId, target.value);
  };

  private commitModelRename(modelId: string, rawName: string): void {
    this.editingModelName = false;
    const mod = this.allModels().find((m) => m.modelId === modelId);
    const trimmed = rawName.trim();
    if (!mod || mod.builtIn || !trimmed || trimmed === mod.name) {
      this.render(true);
      return;
    }
    void this.api
      .updateMLModel(modelId, { name: trimmed })
      .then(() => {
        this.render(true);
      })
      .catch((err: unknown) => this.setErr(err));
  }

  private readonly handleChange = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-include-others")) {
      const sel = this.resolveSelectedModel(this.store.selectedPracticeSession);
      if (sel && isTrainedModel(sel)) {
        this.includeOthersForFineTune = target.checked;
      } else {
        this.includeOthersForNew = target.checked;
      }
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

    const btn = target.closest<HTMLElement>("[data-ai-act]");
    if (!btn || (btn instanceof HTMLButtonElement && btn.disabled)) return;

    const act = btn.dataset.aiAct;
    this.errorMsg = "";

    switch (act) {
      case "create-model":
        this.createModelFromQuery();
        break;

      case "open-review":
        this.onOpenTab("review");
        break;

      case "open-track":
        this.onOpenTab("track");
        break;

      case "edit-model-name": {
        const id = btn.dataset.modelId || "";
        const mod = this.allModels().find((m) => m.modelId === id);
        if (!mod || mod.builtIn) return;
        this.selectedModelId = mod.modelId;
        this.editingModelName = true;
        this.renameDraft = mod.name;
        this.pendingFocusRename = true;
        this.render(true);
        break;
      }

      case "focus-model": {
        const id = btn.dataset.modelId || "";
        const mod = this.allModels().find((m) => m.modelId === id);
        if (mod) {
          this.selectedModelId = mod.modelId;
          this.editingModelName = false;
          this.render(true);
        }
        break;
      }

      case "train-fresh": {
        if (this.startingTraining || this.store.mlStatus.training.running) return;
        const modelId =
          btn.dataset.modelId ||
          this.resolveSelectedModel(this.store.selectedPracticeSession)?.modelId ||
          "";
        if (!modelId) return;
        this.statusMsg = "";
        this.selectedModelId = modelId;
        this.startingTraining = true;
        this.startingEpochs = 28;
        this.render(true);
        void this.api
          .startMLTraining({
            epochs: 28,
            includeUnverified: true,
            sessionIds: this.selectedSessionIds(false),
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
            sessionIds: this.selectedSessionIds(true),
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

      case "delete-model": {
        const modelId = btn.dataset.modelId || "";
        const mod = this.allModels().find((m) => m.modelId === modelId);
        if (!modelId || mod?.builtIn) return;
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
