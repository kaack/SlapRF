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

/**
 * Clean, concise `AI` training tab inside each Practice session (`#/practice/<session>/ai`):
 * - Uses crossings & `.rfbin` traces from the current Practice (and optionally other practices).
 * - Train -> Train More / Retrain -> Mark Ready -> available in Race & Practice `Track`.
 */
export class PracticeAITrainingTab extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onOpenTab: (tab: "review" | "signals" | "track") => void;

  private lastSessionId = "";
  private modelNameDraft = "";
  private includeAllPractices = true;
  private focusedModelId = "";
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

  private resolveCandidateModel(sess: PracticeSession | undefined): MLModelSummary | null {
    const models = this.customModels();
    if (models.length === 0) return null;
    const completedId = this.store.mlStatus.training.completedModelId;
    if (completedId) {
      const m = models.find((x) => x.modelId === completedId);
      if (m) return m;
    }
    if (this.focusedModelId) {
      const m = models.find((x) => x.modelId === this.focusedModelId);
      if (m) return m;
    }
    if (sess) {
      const fromSess = models.find((x) => (x.sourceSessionIds ?? []).includes(sess.sessionId));
      if (fromSess) return fromSess;
    }
    return models[0] ?? null;
  }

  private computeSig(): string {
    const sess = this.store.selectedPracticeSession;
    const ml = this.store.mlStatus;
    const others = this.otherRecordedSessions(sess?.sessionId ?? "");
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
      this.includeAllPractices ? 1 : 0,
      this.focusedModelId,
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
    if (sess && sess.sessionId !== this.lastSessionId) {
      this.lastSessionId = sess.sessionId;
      this.focusedModelId = "";
      const existing = this.resolveCandidateModel(sess);
      this.modelNameDraft = existing?.name || `${sess.name || "Practice"}`;
    } else if (!this.modelNameDraft && sess) {
      this.modelNameDraft = `${sess.name || "Practice"}`;
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
    const totalPasses = curPasses + (this.includeAllPractices ? otherPasses : 0);

    const candidate = this.resolveCandidateModel(sess);
    if (candidate && this.focusedModelId !== candidate.modelId) {
      this.focusedModelId = candidate.modelId;
      this.modelNameDraft = candidate.name;
    }

    const trainPct =
      ml.training.running && ml.training.totalEpochs > 0
        ? Math.min(100, Math.round((ml.training.epoch / ml.training.totalEpochs) * 100))
        : 0;

    const customModels = this.customModels();

    const alertsHtml = `
      ${this.errorMsg ? `<div class="ai-train-banner is-error" role="alert">${esc(this.errorMsg)}</div>` : ""}
      ${this.statusMsg ? `<div class="ai-train-banner is-ok" role="status">${esc(this.statusMsg)}</div>` : ""}`;

    const candidateHtml = candidate
      ? `
        <div class="ai-scorecard-box">
          <div class="ai-card-head">
            <div class="ai-model-title-line">
              <strong>${esc(candidate.name)}</strong>
              <span class="race-state-pill ${candidate.ready ? "is-live" : "is-paused"}">
                ${candidate.ready ? "Ready ✓" : "Draft"}
              </span>
              <span class="note">${candidate.epochsTrained ?? 28} epochs</span>
            </div>
            <div class="ai-card-actions">
              <button
                type="button"
                class="btn btn-xs ${candidate.ready ? "btn-ghost" : "btn-primary"}"
                data-ai-act="toggle-model-ready"
                data-model-id="${esc(candidate.modelId)}"
              >${candidate.ready ? "Unmark Ready" : "✓ Mark Ready"}</button>
              ${
                candidate.ready
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-ai-act="open-track">Track →</button>`
                  : ""
              }
            </div>
          </div>
          <div class="table-scroll">
            <table class="table rc-compact-table ai-scorecard-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Classic</th>
                  <th>AI</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Passes found</td>
                  <td class="mono">${candidate.classicMetrics.detectedPasses} / ${candidate.classicMetrics.totalPasses}</td>
                  <td class="mono"><strong>${candidate.aiMetrics.detectedPasses} / ${candidate.aiMetrics.totalPasses}</strong></td>
                </tr>
                <tr>
                  <td>False triggers</td>
                  <td class="mono">${candidate.classicMetrics.falseTriggers}</td>
                  <td class="mono"><strong>${candidate.aiMetrics.falseTriggers}</strong></td>
                </tr>
                <tr>
                  <td>Accuracy</td>
                  <td class="mono">${(candidate.classicMetrics.f1 * 100).toFixed(1)}%</td>
                  <td class="mono"><strong>${(candidate.aiMetrics.f1 * 100).toFixed(1)}%</strong></td>
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
          <div class="ai-card-head">
            <h3 class="ai-card-title">Models</h3>
            <div class="ai-card-actions">
              <button type="button" class="btn btn-ghost btn-xs" data-ai-act="export-dataset">Export</button>
              <label class="btn btn-ghost btn-xs ai-import-label">
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
                    <div class="ai-model-meta" data-ai-act="focus-model" data-model-id="${esc(m.modelId)}" style="cursor:pointer">
                      <div class="ai-model-title-line">
                        <strong>${esc(m.name)}</strong>
                        <span class="race-state-pill ${m.ready ? "is-live" : "is-paused"}">${m.ready ? "Ready ✓" : "Draft"}</span>
                        ${isActive ? `<span class="scope-ai-chip">Active</span>` : ""}
                      </div>
                      <span class="note">${(m.aiMetrics.f1 * 100).toFixed(1)}% accuracy · ${m.trainPasses} passes</span>
                    </div>
                    <div class="ai-card-actions">
                      <button
                        type="button"
                        class="btn btn-xs ${m.ready ? "btn-ghost" : "btn-primary"}"
                        data-ai-act="toggle-model-ready"
                        data-model-id="${esc(m.modelId)}"
                      >${m.ready ? "Unmark" : "Mark Ready"}</button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
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
          <div class="ai-card-head">
            <div class="ai-model-title-line">
              <h3 class="ai-card-title">AI Training</h3>
              <span class="badge mono">${curLaps} laps · ${curPasses} passes</span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-ai-act="open-review">
              ${icons.reviewCheck(14)}<span>Review Laps</span>
            </button>
          </div>

          ${
            others.length > 0
              ? `<label class="ai-check-label">
                   <input type="checkbox" data-ai-include-others ${this.includeAllPractices ? "checked" : ""} />
                   <span>Include ${others.length} other practice${others.length === 1 ? "" : "s"} (${totalPasses} passes total)</span>
                 </label>`
              : ""
          }

          <div class="ai-train-controls-row">
            <input
              type="text"
              class="input ai-name-input"
              data-ai-model-name
              aria-label="Model name"
              value="${esc(this.modelNameDraft)}"
              placeholder="Model name"
            />
            <div class="ai-card-actions">
              ${
                candidate
                  ? `<button
                       type="button"
                       class="btn btn-primary btn-sm"
                       data-ai-act="train-more"
                       data-model-id="${esc(candidate.modelId)}"
                       ${ml.training.running ? "disabled" : ""}
                     >${ml.training.running ? "Training…" : "Train More"}</button>
                     <button
                       type="button"
                       class="btn btn-ghost btn-sm"
                       data-ai-act="train-fresh"
                       ${ml.training.running ? "disabled" : ""}
                     >Retrain</button>`
                  : `<button
                       type="button"
                       class="btn btn-primary btn-sm"
                       data-ai-act="train-fresh"
                       ${ml.training.running ? "disabled" : ""}
                     >${ml.training.running ? "Training…" : "Train"}</button>`
              }
            </div>
          </div>

          ${
            ml.training.running
              ? `<div class="ai-train-progress-wrap">
                   <div class="ai-train-progress-text">
                     <span>Epoch ${ml.training.epoch} / ${ml.training.totalEpochs}</span>
                     <span class="mono">loss ${ml.training.loss.toFixed(4)}</span>
                   </div>
                   <div class="ai-progress-track">
                     <div class="ai-progress-fill" style="width:${trainPct}%"></div>
                   </div>
                 </div>`
              : ""
          }

          ${candidateHtml}
        </div>

        ${savedModelsHtml}
      </div>`;
  }

  private selectedSessionIds(): string[] {
    const sess = this.store.selectedPracticeSession;
    if (!sess) return [];
    if (!this.includeAllPractices) {
      return [sess.sessionId];
    }
    const others = this.otherRecordedSessions(sess.sessionId).map((s) => s.sessionId);
    return [sess.sessionId, ...others];
  }

  private readonly handleInput = (e: Event): void => {
    const target = e.target;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-model-name")) {
      this.modelNameDraft = target.value;
    }
  };

  private readonly handleChange = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-include-others")) {
      this.includeAllPractices = target.checked;
      this.render(true);
      return;
    }

    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-model-name")) {
      this.modelNameDraft = target.value.trim() || this.modelNameDraft;
      const cand = this.resolveCandidateModel(this.store.selectedPracticeSession);
      if (cand && this.modelNameDraft && this.modelNameDraft !== cand.name) {
        void this.api
          .updateMLModel(cand.modelId, { name: this.modelNameDraft })
          .catch((err: unknown) => this.setErr(err));
      }
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
          this.focusedModelId = mod.modelId;
          this.modelNameDraft = mod.name;
          this.render(true);
        }
        break;
      }

      case "train-fresh": {
        this.statusMsg = "";
        const sess = this.store.selectedPracticeSession;
        const cleanName = this.modelNameDraft.trim() || `${sess?.name || "Practice"}`;
        void this.api
          .startMLTraining({
            epochs: 28,
            includeUnverified: true,
            sessionIds: this.selectedSessionIds(),
            modelName: cleanName,
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }

      case "train-more": {
        this.statusMsg = "";
        const modelId = btn.dataset.modelId || "";
        if (!modelId) return;
        const cleanName = this.modelNameDraft.trim();
        void this.api
          .startMLTraining({
            epochs: 20,
            includeUnverified: true,
            sessionIds: this.selectedSessionIds(),
            continueModelId: modelId,
            modelName: cleanName || undefined,
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }

      case "toggle-model-ready": {
        const modelId = btn.dataset.modelId || "";
        const mod = this.customModels().find((m) => m.modelId === modelId);
        if (!mod) return;
        const nextReady = !mod.ready;
        const pendingName =
          this.focusedModelId === mod.modelId && this.modelNameDraft.trim()
            ? this.modelNameDraft.trim()
            : mod.name;
        void this.api
          .updateMLModel(modelId, { ready: nextReady, name: pendingName })
          .then(() => {
            this.statusMsg = nextReady
              ? `"${pendingName}" is Ready ✓ — select it in Track.`
              : `"${pendingName}" moved back to Draft.`;
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }

      case "delete-model": {
        const modelId = btn.dataset.modelId || "";
        if (!modelId) return;
        if (this.focusedModelId === modelId) {
          this.focusedModelId = "";
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
