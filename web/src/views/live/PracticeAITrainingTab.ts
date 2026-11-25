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
 * Embedded `AI Training` tab inside a Practice session workspace (`#/practice/<session>/ai`):
 * - Uses the current Practice session's `.rfbin` trace and crossings (including any edits made in `Signals`).
 * - Optionally includes other recorded Practice sessions so multi-pack runs combine seamlessly.
 * - Supports iterative training (`Train Model`, `Train More (+20 Epochs)`, `Retrain`), displays the
 *   validation scorecard vs Classic DSP, and lets the user mark a model as **Ready** so it becomes
 *   selectable in `Track` (`Race -> Track` and `Practice -> Track`).
 */
export class PracticeAITrainingTab extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onOpenTab: (tab: "signals" | "track") => void;

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
    onOpenTab: (tab: "signals" | "track") => void
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
        if (active instanceof HTMLInputElement && this.el.contains(active) && active.hasAttribute("data-ai-model-name")) {
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
      sess?.traceSampleCount ?? 0,
      Math.round(sess?.traceDurationSec ?? 0),
      others.length,
      others.reduce((sum, s) => sum + countValidPasses(s), 0),
      this.includeAllPractices ? 1 : 0,
      this.focusedModelId,
      ml.config.detectorMode,
      ml.config.activeModelId,
      ml.config.liveTuneEnabled ? 1 : 0,
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
      this.modelNameDraft = existing?.name || `${sess.name || "Practice"} Model`;
    } else if (!this.modelNameDraft && sess) {
      this.modelNameDraft = `${sess.name || "Practice"} Model`;
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
    const manualEdits = (sess.crossings ?? []).filter((c) => c.manual).length;
    const others = this.otherRecordedSessions(sess.sessionId);
    const otherPasses = others.reduce((sum, s) => sum + countValidPasses(s), 0);
    const totalSelectedPasses = curPasses + (this.includeAllPractices ? otherPasses : 0);
    const totalSelectedSessions = 1 + (this.includeAllPractices ? others.length : 0);

    const candidate = this.resolveCandidateModel(sess);
    if (candidate && this.focusedModelId !== candidate.modelId) {
      this.focusedModelId = candidate.modelId;
      this.modelNameDraft = candidate.name;
    }

    const trainPct =
      ml.training.running && ml.training.totalEpochs > 0
        ? Math.min(100, Math.round((ml.training.epoch / ml.training.totalEpochs) * 100))
        : ml.training.completedModelId
          ? 100
          : 0;

    const customModels = this.customModels();
    const readyCount = customModels.filter((m) => m.ready).length;

    const alertsHtml = `
      ${this.errorMsg ? `<div class="ai-train-banner is-error" role="alert">${esc(this.errorMsg)}</div>` : ""}
      ${this.statusMsg ? `<div class="ai-train-banner is-ok" role="status">${esc(this.statusMsg)}</div>` : ""}`;

    const scorecardHtml = candidate
      ? `
        <div class="ai-scorecard-box">
          <div class="ai-card-head">
            <div>
              <div class="ai-scorecard-title">
                ${esc(candidate.name)}
                <span class="race-state-pill ${candidate.ready ? "is-live" : "is-paused"}" style="margin-left:6px">
                  ${candidate.ready ? "Ready ✓" : "Draft"}
                </span>
              </div>
              <span class="note">${candidate.epochsTrained ?? 28} epochs · trained on ${candidate.trainPasses} passes</span>
            </div>
            <div class="ai-card-actions">
              <button
                type="button"
                class="btn btn-sm ${candidate.ready ? "btn-ghost" : "btn-primary"}"
                data-ai-act="toggle-model-ready"
                data-model-id="${esc(candidate.modelId)}"
              >${candidate.ready ? "Unmark Ready" : "✓ Mark Model as Ready"}</button>
              ${
                candidate.ready
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-ai-act="open-track">Select in Track →</button>`
                  : ""
              }
            </div>
          </div>
          <div class="table-scroll">
            <table class="table ai-scorecard-table">
              <thead>
                <tr>
                  <th>Validation Metric</th>
                  <th>Classic DSP</th>
                  <th>${esc(candidate.name)}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Detected Passes</td>
                  <td class="mono">${candidate.classicMetrics.detectedPasses} / ${candidate.classicMetrics.totalPasses}</td>
                  <td class="mono"><strong>${candidate.aiMetrics.detectedPasses} / ${candidate.aiMetrics.totalPasses}</strong></td>
                </tr>
                <tr>
                  <td>Missed Passes</td>
                  <td class="mono">${candidate.classicMetrics.missedPasses}</td>
                  <td class="mono"><strong>${candidate.aiMetrics.missedPasses}</strong></td>
                </tr>
                <tr>
                  <td>False Triggers</td>
                  <td class="mono">${candidate.classicMetrics.falseTriggers}</td>
                  <td class="mono"><strong>${candidate.aiMetrics.falseTriggers}</strong></td>
                </tr>
                <tr>
                  <td>F1 Accuracy</td>
                  <td class="mono">${(candidate.classicMetrics.f1 * 100).toFixed(1)}%</td>
                  <td class="mono"><strong>${(candidate.aiMetrics.f1 * 100).toFixed(1)}%</strong></td>
                </tr>
                <tr>
                  <td>Timing Jitter</td>
                  <td class="mono">±${candidate.classicMetrics.meanJitterMs.toFixed(1)} ms</td>
                  <td class="mono"><strong>±${candidate.aiMetrics.meanJitterMs.toFixed(1)} ms</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>`
      : "";

    const savedModelsCardHtml =
      customModels.length > 0
        ? `
        <div class="card ai-train-card">
          <div class="ai-card-head">
            <div>
              <h3 class="ai-card-title">Trained Models (${readyCount} Ready)</h3>
              <p class="note">Models marked <strong>Ready ✓</strong> appear as selectable crossing detectors in <strong>Track</strong> inside any Race or Practice.</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-ai-act="open-track">
              ${icons.gate(14)}<span>Open Track Tab</span>
            </button>
          </div>
          <div class="ai-model-list">
            ${customModels
              .map((m) => {
                const isActive = ml.config.detectorMode === "ai" && ml.config.activeModelId === m.modelId;
                const isFocused = candidate?.modelId === m.modelId;
                return `
                  <div class="ai-model-row ${isActive ? "is-active" : ""}">
                    <div class="ai-model-meta" data-ai-act="focus-model" data-model-id="${esc(m.modelId)}" style="cursor:pointer">
                      <div class="ai-model-title-line">
                        <strong>${esc(m.name)}</strong>
                        <span class="race-state-pill ${m.ready ? "is-live" : "is-paused"}">${m.ready ? "Ready ✓" : "Draft"}</span>
                        ${isActive ? `<span class="scope-ai-chip">Active Detector</span>` : ""}
                        ${isFocused && !isActive ? `<span class="note">(Selected above)</span>` : ""}
                      </div>
                      <span class="note">F1 ${(m.aiMetrics.f1 * 100).toFixed(1)}% · ±${m.aiMetrics.meanJitterMs.toFixed(1)} ms · ${m.epochsTrained ?? 28} epochs · ${m.trainPasses} passes</span>
                    </div>
                    <div class="ai-card-actions">
                      <button
                        type="button"
                        class="btn btn-xs ${m.ready ? "btn-ghost" : "btn-primary"}"
                        data-ai-act="toggle-model-ready"
                        data-model-id="${esc(m.modelId)}"
                      >${m.ready ? "Unmark Ready" : "✓ Mark Ready"}</button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        data-ai-act="delete-model"
                        data-model-id="${esc(m.modelId)}"
                        title="Delete model ${esc(m.name)}"
                        aria-label="Delete model ${esc(m.name)}"
                      >${icons.trash(13)}</button>
                    </div>
                  </div>`;
              })
              .join("")}
          </div>
          <div class="ai-export-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-ai-act="export-dataset">
              Export Traces &amp; Models (.tar.gz)
            </button>
            <label class="btn btn-ghost btn-sm ai-import-label">
              <span>Import (.tar.gz)</span>
              <input type="file" accept=".gz,.tgz,application/gzip" data-ai-import-file hidden />
            </label>
          </div>
        </div>`
        : "";

    this.el.innerHTML = `
      <div class="ai-train-stack">
        ${alertsHtml}

        <div class="card ai-train-card">
          <div class="ai-card-head">
            <div>
              <h3 class="ai-card-title">Train Crossing Model from Practice</h3>
              <p class="note">Fly laps naturally in this Practice and adjust any crossings in <strong>Signals</strong>. Your 50 Hz RF traces are captured automatically in the background.</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-ai-act="open-signals">
              ${icons.signal(14)}<span>Review Crossings in Signals</span>
            </button>
          </div>

          <div class="ai-pack-status-box">
            <div class="ai-pack-kpis">
              <span>This Practice (<strong>${esc(sess.name)}</strong>): <strong>${curLaps}</strong> lap${curLaps === 1 ? "" : "s"} · <strong>${curPasses}</strong> pass${curPasses === 1 ? "" : "es"}${manualEdits > 0 ? ` (${manualEdits} manual edit${manualEdits === 1 ? "" : "s"})` : ""}</span>
              ${
                others.length > 0
                  ? `<label class="ai-check-label">
                       <input type="checkbox" data-ai-include-others ${this.includeAllPractices ? "checked" : ""} />
                       <span>Also include ${others.length} other recorded practice${others.length === 1 ? "" : "s"} (+${otherPasses} passes → <strong>${totalSelectedPasses} total</strong>)</span>
                     </label>`
                  : ""
              }
            </div>
          </div>

          <div class="ai-train-controls-row">
            <label class="ai-name-field">
              <span class="note">Model name</span>
              <input
                type="text"
                class="input"
                data-ai-model-name
                value="${esc(this.modelNameDraft)}"
                placeholder="${esc(`${sess.name || "Practice"} Model`)}"
              />
            </label>
            <div class="ai-card-actions">
              ${
                candidate
                  ? `<button
                       type="button"
                       class="btn btn-primary"
                       data-ai-act="train-more"
                       data-model-id="${esc(candidate.modelId)}"
                       ${ml.training.running ? "disabled" : ""}
                     >${ml.training.running ? "Training..." : "Train More (+20 Epochs)"}</button>
                     <button
                       type="button"
                       class="btn btn-ghost"
                       data-ai-act="train-fresh"
                       ${ml.training.running ? "disabled" : ""}
                       title="Start a fresh model run from updated Signals crossings (${totalSelectedSessions} session${totalSelectedSessions === 1 ? "" : "s"})"
                     >Retrain Fresh</button>`
                  : `<button
                       type="button"
                       class="btn btn-primary"
                       data-ai-act="train-fresh"
                       ${ml.training.running ? "disabled" : ""}
                     >${ml.training.running ? "Training..." : "Train Model"}</button>`
              }
            </div>
          </div>

          ${
            ml.training.running || ml.training.message
              ? `<div class="ai-train-progress-wrap">
                   <div class="ai-train-progress-text">
                     <span>${esc(ml.training.message || "Ready")}</span>
                     ${ml.training.totalEpochs > 0 ? `<span class="mono">${ml.training.epoch}/${ml.training.totalEpochs} · loss ${ml.training.loss.toFixed(4)}</span>` : ""}
                   </div>
                   <div class="ai-progress-track">
                     <div class="ai-progress-fill" style="width:${trainPct}%"></div>
                   </div>
                 </div>`
              : ""
          }

          ${scorecardHtml}
        </div>

        ${savedModelsCardHtml}
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
      case "open-signals":
        this.onOpenTab("signals");
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
        const cleanName =
          this.modelNameDraft.trim() || `${sess?.name || "Practice"} Model`;
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
              ? `"${pendingName}" is marked Ready ✓ — select it anytime in Race → Track or Practice → Track.`
              : `"${pendingName}" returned to Draft.`;
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
            this.statusMsg = "Deleted model snapshot.";
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
