import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  AITrainingTab,
  buildAITrainingHash,
  buildPracticeHash,
  getCurrentParsedHash,
  onAITrainingRouteTargetChange,
  pushAppHash,
} from "../core/router";
import { formatBandChannelShort } from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import { gateLabel } from "../state/selectors";
import { AppStore } from "../state/store";
import { MLModelSummary, PracticeSession } from "../types/models";
import { FILTER_SHORT_CODES } from "../widgets/markup";
import { PilotRssiChart } from "../widgets/PilotRssiChart";

interface BorderlineEvent {
  key: string;
  kind: "filtered" | "invalid_crossing";
  gateId: number;
  gateLabel: string;
  slotIndex: number;
  timestampUs: number;
  peakRssiDbm: number;
  code: string;
  detail: string;
  eventId?: number;
}

function formatBytesShort(bytes: number): string {
  if (!(bytes > 0)) return "0 KB";
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Top-level AI Training workspace (`#/ai`, `#/ai/review`, `#/ai/train`):
 * 1. Collect: Hands-free back-to-back flight pack loop with VTX quiet auto-sealing.
 * 2. Review: Fast pack-by-pack `.rfbin` trace replay, borderline event promotion/rejection, and pack verification.
 * 3. Train: On-device 1D dilated TCN base model trainer, holdout scorecard vs Classic DSP, model snapshots, and `.tar.gz` export/import.
 */
export class AITrainingView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly tabBarEl: HTMLElement;
  private readonly bodyEl: HTMLElement;

  private activeTab: AITrainingTab = "collect";
  private reviewSessionId = "";
  private reviewEventIdx = 0;
  private readonly dismissedEventKeys = new Set<string>();

  private reviewChart: PilotRssiChart | null = null;
  private reviewChartEl: HTMLElement | null = null;
  private reviewChartMountedSessionId = "";
  private isViewActive = true;
  private lastTabSig = "";
  private lastRenderSig = "";
  private statusMsg = "";
  private errorMsg = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    const initial = getCurrentParsedHash().ai;
    if (initial) {
      this.activeTab = initial.tab;
      if (initial.sessionId) {
        this.reviewSessionId = initial.sessionId;
      }
    }

    el.innerHTML = `
      <div class="view-stack ai-training-page">
        <div class="races-page-topbar ai-page-topbar" data-slot="topbar"></div>
        <div class="settings-section is-single-col">
          <div class="settings-cards ai-train-stack" data-slot="body"></div>
        </div>
      </div>`;

    this.tabBarEl = this.slot("topbar");
    this.bodyEl = this.slot("body");

    this.listen(el, "click", this.handleClick);
    this.listen(el, "change", this.handleChange);

    this.onDispose(() => {
      this.disposeReviewChart();
    });
    this.onDispose(
      onAITrainingRouteTargetChange((target) => {
        this.activeTab = target.tab;
        if (target.sessionId) {
          this.reviewSessionId = target.sessionId;
          this.reviewEventIdx = 0;
        }
        if (this.isViewActive) {
          this.render(true);
        }
      })
    );
    this.onDispose(
      store.subscribe(["practice", "ml", "config", "status", "laps", "crossings"], () => {
        if (!this.isViewActive) return;
        this.render();
      })
    );

    void this.api.fetchMLStatus().catch(() => undefined);
    this.render(true);
  }

  public override onDeactivate(): void {
    this.isViewActive = false;
    this.disposeReviewChart();
  }

  public override onActivate(): void {
    this.isViewActive = true;
    const cur = getCurrentParsedHash().ai;
    if (cur) {
      this.activeTab = cur.tab;
      if (cur.sessionId) {
        this.reviewSessionId = cur.sessionId;
      }
    }
    void this.api.fetchMLStatus().catch(() => undefined);
    this.render(true);
  }

  private disposeReviewChart(): void {
    if (this.reviewChart) {
      this.reviewChart.destroy();
      this.reviewChart = null;
    }
    if (this.reviewChartEl) {
      this.reviewChartEl.remove();
      this.reviewChartEl = null;
    }
    this.reviewChartMountedSessionId = "";
  }

  private switchTab(tab: AITrainingTab, sessionId?: string, pushHistory = true): void {
    this.activeTab = tab;
    if (sessionId !== undefined) {
      this.reviewSessionId = sessionId;
      this.reviewEventIdx = 0;
    }
    if (pushHistory) {
      pushAppHash(buildAITrainingHash(tab, tab === "review" ? this.reviewSessionId || undefined : undefined));
    }
    this.render(true);
  }

  private recordableSessions(): PracticeSession[] {
    return this.store.practiceSessions.filter(
      (s) =>
        (s.traceSampleCount ?? 0) > 0 ||
        s.crossings.length > 0 ||
        s.laps.length > 0 ||
        Boolean(s.trainingVerified) ||
        (s.tags ?? []).some((t) => t.toLowerCase() === "ai-pack")
    );
  }

  private computeBorderlineEvents(sess: PracticeSession): BorderlineEvent[] {
    const nodes = this.store.practiceSessionNodes(sess).nodes;
    const labelOf = (gateId: number): string => {
      const n = nodes.find((g) => g.gateId === gateId);
      return n?.name?.trim() || n?.timerLabel?.trim() || `G${gateId}`;
    };

    const items: BorderlineEvent[] = [];
    for (const f of sess.filtered ?? []) {
      const key = `filt:${f.gateId}:${f.slotIndex}:${Math.round(f.timestampUs / 50_000)}`;
      if (this.dismissedEventKeys.has(key)) continue;
      const alreadyPromoted = sess.crossings.some(
        (c) =>
          c.gateId === f.gateId &&
          c.slotIndex === f.slotIndex &&
          Math.abs(c.timestampUs - f.timestampUs) <= 200_000
      );
      if (alreadyPromoted) continue;
      const gLabel = labelOf(f.gateId);
      const shortCode = FILTER_SHORT_CODES[f.reason] || f.reason;
      const code = f.reason === "OUT_OF_ORDER" ? `${gLabel}-${shortCode}` : shortCode;
      items.push({
        key,
        kind: "filtered",
        gateId: f.gateId,
        gateLabel: gLabel,
        slotIndex: f.slotIndex,
        timestampUs: f.timestampUs,
        peakRssiDbm: f.peakRssiDbm,
        code,
        detail: f.detail || code,
      });
    }

    for (const c of sess.crossings ?? []) {
      if (!c.invalidReason) continue;
      const key = `inv:${c.eventId}`;
      if (this.dismissedEventKeys.has(key)) continue;
      const gLabel = labelOf(c.gateId);
      const shortCode = FILTER_SHORT_CODES[c.invalidReason] || c.invalidReason;
      const code = c.invalidReason === "OUT_OF_ORDER" ? `${gLabel}-${shortCode}` : shortCode;
      items.push({
        key,
        kind: "invalid_crossing",
        gateId: c.gateId,
        gateLabel: gLabel,
        slotIndex: c.slotIndex,
        timestampUs: c.timestampUs,
        peakRssiDbm: c.peakRssiDbm,
        code,
        detail: c.invalidDetail || code,
        eventId: c.eventId,
      });
    }

    items.sort((a, b) => a.timestampUs - b.timestampUs);
    return items;
  }

  private renderTabBar(): void {
    const packs = this.recordableSessions();
    const unverifiedCount = packs.filter((s) => !s.active && !s.trainingVerified).length;
    const ml = this.store.mlStatus;
    const tabSig = `${this.activeTab}:${unverifiedCount}:${ml.training.running ? 1 : 0}`;
    if (tabSig === this.lastTabSig) return;
    this.lastTabSig = tabSig;

    const reviewBadge =
      unverifiedCount > 0
        ? `<span class="ai-tab-count" title="${unverifiedCount} unverified pack${unverifiedCount === 1 ? "" : "s"}">${unverifiedCount}</span>`
        : "";

    this.tabBarEl.innerHTML = `
      <div class="rc-topbar-side is-left" aria-hidden="true"></div>
      <div class="rc-topleft-bar">
        <div class="sched-lineup-wrap rc-topleft-scroll-wrap">
          <div class="rc-topleft-seg sched-lineup" role="tablist" aria-label="AI Training workflow">
            <button
              type="button"
              role="tab"
              aria-selected="${this.activeTab === "collect" ? "true" : "false"}"
              class="rc-topleft-btn rc-mode-btn ${this.activeTab === "collect" ? "is-active" : ""}"
              data-ai-tab="collect"
            >
              ${icons.flag(15)}<span>Collect</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="${this.activeTab === "review" ? "true" : "false"}"
              class="rc-topleft-btn rc-mode-btn ${this.activeTab === "review" ? "is-active" : ""}"
              data-ai-tab="review"
            >
              ${icons.reviewCheck(15)}<span>Review</span>${reviewBadge}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="${this.activeTab === "train" ? "true" : "false"}"
              class="rc-topleft-btn rc-mode-btn ${this.activeTab === "train" ? "is-active" : ""}"
              data-ai-tab="train"
            >
              ${icons.ai(15)}<span>Train</span>
            </button>
          </div>
        </div>
      </div>
      <div class="rc-topbar-side is-right" aria-hidden="true"></div>`;
  }

  private computeSig(): string {
    const ps = this.store.practiceState;
    const ml = this.store.mlStatus;
    const packs = this.recordableSessions();
    const packsSig = packs
      .map(
        (s) =>
          `${s.sessionId}:${s.name}:${s.active ? 1 : 0}:${s.trainingVerified ? 1 : 0}:${s.laps.length}:${s.crossings.length}:${s.filtered.length}:${s.traceSampleCount ?? 0}:${this.store.hasSessionTrace(s.sessionId) ? 1 : 0}`
      )
      .join("|");
    const pilotsSig = this.store.pilots
      .filter((p) => p.enabled)
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.band ?? 1}:${p.channel}:${p.frequencyMhz}`)
      .join(",");
    const gatesSig = this.store.nodes
      .map((g) => `${g.gateId}:${g.name}:${g.assignedTimerId ?? 0}`)
      .join(",");
    const modelsSig = (ml.models ?? [])
      .map((m) => `${m.modelId}:${m.aiMetrics?.f1 ?? 0}`)
      .join(",");
    return [
      this.activeTab,
      this.reviewSessionId,
      this.reviewEventIdx,
      this.dismissedEventKeys.size,
      ps.packLoopEnabled ? 1 : 0,
      ps.packLoopQuietSec ?? 25,
      ps.packLoopState ?? "",
      Math.floor(ps.packLoopQuietElapsed ?? 0),
      ps.activeSessionId,
      ml.config.detectorMode,
      ml.config.activeModelId,
      ml.config.liveTuneEnabled ? 1 : 0,
      ml.training.running ? 1 : 0,
      ml.training.epoch,
      ml.training.totalEpochs,
      ml.training.loss,
      ml.training.message ?? "",
      ml.verifiedPacks,
      ml.unverifiedPacks,
      ml.verifiedPasses,
      ml.storageBytes,
      (ml.liveTunes ?? []).length,
      pilotsSig,
      gatesSig,
      modelsSig,
      packsSig,
      this.statusMsg,
      this.errorMsg,
    ].join("::");
  }

  public render(force = false): void {
    this.renderTabBar();
    const sig = this.computeSig();
    if (!force && sig === this.lastRenderSig) {
      return;
    }
    this.lastRenderSig = sig;

    if (this.activeTab === "review") {
      this.renderReviewTab();
    } else if (this.activeTab === "train") {
      this.disposeReviewChart();
      this.renderTrainTab();
    } else {
      this.disposeReviewChart();
      this.renderCollectTab();
    }
  }

  private renderAlertsHtml(): string {
    return `
      ${this.errorMsg ? `<div class="ai-train-banner is-error" role="alert">${esc(this.errorMsg)}</div>` : ""}
      ${this.statusMsg ? `<div class="ai-train-banner is-ok" role="status">${esc(this.statusMsg)}</div>` : ""}`;
  }

  private renderCollectTab(): void {
    const ps = this.store.practiceState;
    const ml = this.store.mlStatus;
    const packs = this.recordableSessions();
    const unverifiedPacks = packs.filter((s) => !s.trainingVerified && !s.active);
    const activeSess = this.store.activePracticeSession;

    const enabledPilots = this.store.pilots.filter((p) => p.enabled);
    const pilotSummary =
      enabledPilots.length > 0
        ? enabledPilots
            .map(
              (p) =>
                `${p.callsign} (${formatBandChannelShort(p.band, p.channel)} · ${p.frequencyMhz} MHz)`
            )
            .join(", ")
        : "No active pilot enabled — configure your VTX channel in Pilots first";

    const nodes = this.store.nodes;
    const onlineTimers = this.store.detectedTimers.filter((t) => t.online).length;
    const trackSummary =
      nodes.length > 0
        ? `${nodes.map((g) => gateLabel(this.store, g.gateId)).join(" → ")} (${onlineTimers} online)`
        : "No timers on track — connect your Hub/Spokes in Network";

    const quietSec = ps.packLoopQuietSec && ps.packLoopQuietSec >= 10 ? ps.packLoopQuietSec : 25;
    const quietElapsed = Math.min(quietSec, Math.max(0, ps.packLoopQuietElapsed ?? 0));
    const quietPct = Math.min(100, Math.round((quietElapsed / quietSec) * 100));

    let vtxStatusLabel = "Standby — Start Pack Loop before putting your goggles on";
    if (ps.packLoopEnabled) {
      if (ps.packLoopState === "quiet_sealing") {
        const rem = Math.max(0, Math.ceil(quietSec - quietElapsed));
        vtxStatusLabel = `Quad unplugged — Sealing pack in ${rem}s (${Math.floor(quietElapsed)}s / ${quietSec}s quiet)`;
      } else if (ps.packLoopState === "flying") {
        const laps = activeSess?.laps.filter((l) => !l.invalidated).length ?? 0;
        vtxStatusLabel = `Flying live — ${laps} lap${laps === 1 ? "" : "s"} recorded in ${activeSess?.name || "current pack"}`;
      } else {
        vtxStatusLabel = `Waiting for VTX power-on — ${activeSess?.name || "Pack"} armed`;
      }
    }

    const totalRunLaps = packs.reduce(
      (acc, s) => acc + s.laps.filter((l) => !l.invalidated).length,
      0
    );
    const totalRunPasses = packs.reduce(
      (acc, s) => acc + s.crossings.filter((c) => !c.invalidReason || c.manual).length,
      0
    );

    const activeModel =
      (ml.models ?? []).find((m) => m.modelId === ml.config.activeModelId) ?? (ml.models ?? [])[0];
    const detectorLabel =
      ml.config.detectorMode === "ai"
        ? `AI Detector (v${activeModel?.version ?? 0})`
        : "Classic DSP";

    this.bodyEl.innerHTML = `
      ${this.renderAlertsHtml()}

      <div class="card ai-train-card">
        <div class="ai-card-head">
          <div>
            <h3 class="ai-card-title">Hands-Free Back-to-Back Pack Loop</h3>
            <p class="note">Fly packs back-to-back without touching your phone or laptop. Unplugging your quad for ${quietSec}s automatically seals the pack's 50 Hz <code>.rfbin</code> trace and arms the next pack.</p>
          </div>
          <span class="race-state-pill ${ps.packLoopEnabled ? "is-live" : "is-waiting"}">
            ${ps.packLoopEnabled ? "LOOP LIVE" : "STANDBY"}
          </span>
        </div>

        <div class="ai-readiness-grid">
          <div class="ai-readiness-item">
            <span class="note">Pilot &amp; Channel</span>
            <strong>${esc(pilotSummary)}</strong>
          </div>
          <div class="ai-readiness-item">
            <span class="note">Track Timers &amp; Live Detector</span>
            <strong>${esc(trackSummary)} · ${esc(detectorLabel)}</strong>
          </div>
        </div>

        <div class="ai-pack-status-box">
          <div class="ai-pack-status-line">
            <strong>${esc(vtxStatusLabel)}</strong>
          </div>
          ${
            ps.packLoopEnabled && ps.packLoopState === "quiet_sealing"
              ? `<div class="ai-progress-track"><div class="ai-progress-fill is-warn" style="width:${quietPct}%"></div></div>`
              : ""
          }
          <div class="ai-pack-kpis">
            <span><strong>${packs.length}</strong> Recorded Packs</span>
            <span><strong>${totalRunLaps}</strong> Total Laps</span>
            <span><strong>${totalRunPasses}</strong> Single-Timer Passes</span>
            <span>Quiet Auto-Split:
              <select class="input ai-quiet-select" data-ai-quiet-sec aria-label="Quiet timeout seconds">
                ${[15, 25, 35, 45]
                  .map(
                    (sec) =>
                      `<option value="${sec}" ${quietSec === sec ? "selected" : ""}>${sec}s</option>`
                  )
                  .join("")}
              </select>
            </span>
          </div>
        </div>

        <div class="ai-card-actions">
          ${
            ps.packLoopEnabled
              ? `<button type="button" class="btn btn-ghost" data-ai-act="stop-pack-loop">Stop Pack Loop</button>
                 <button type="button" class="btn btn-primary" data-ai-act="split-pack-now">Seal &amp; Arm Next Pack Now</button>`
              : `<button type="button" class="btn btn-primary" data-ai-act="start-pack-loop">Start Back-to-Back Pack Loop</button>`
          }
          <a class="btn btn-ghost btn-sm" href="#/pilots">Pilots</a>
          <a class="btn btn-ghost btn-sm" href="#/network">Network</a>
        </div>
      </div>

      <div class="card ai-train-card">
        <div class="ai-card-head">
          <div>
            <h3 class="ai-card-title">Recorded Flight Packs</h3>
            <p class="note">Any Practice session or Pack Loop pack with recorded RF telemetry appears here. Tap a stopped pack to verify its crossings in Review.</p>
          </div>
          ${
            unverifiedPacks.length > 0
              ? `<button type="button" class="btn btn-primary btn-sm" data-ai-act="review-next-unverified">
                   Review ${unverifiedPacks.length} Unverified Pack${unverifiedPacks.length === 1 ? "" : "s"} →
                 </button>`
              : packs.filter((s) => !s.active).length > 0
                ? `<button type="button" class="btn btn-primary btn-sm" data-ai-tab="train">
                     Proceed to Train →
                   </button>`
                : ""
          }
        </div>

        ${
          packs.length > 0
            ? `<div class="ai-pack-strip">
                ${packs
                  .slice()
                  .reverse()
                  .map((s) => {
                    const validLaps = s.laps.filter((l) => !l.invalidated).length;
                    const badge = s.active
                      ? "LIVE"
                      : s.trainingVerified
                        ? "Verified ✓"
                        : "Unverified";
                    const cls = s.active
                      ? "is-live"
                      : s.trainingVerified
                        ? "is-verified"
                        : "is-unverified";
                    return `
                      <button
                        type="button"
                        class="ai-pack-chip ${cls}"
                        data-ai-act="review-pack"
                        data-session-id="${esc(s.sessionId)}"
                      >
                        <strong>${esc(s.name)}</strong>
                        <span class="note">${validLaps}L · ${s.crossings.length} passes · ${badge}</span>
                      </button>`;
                  })
                  .join("")}
              </div>`
            : `<p class="note">No recorded packs yet. Tap <strong>Start Back-to-Back Pack Loop</strong> above (or run any Practice session) and fly a few laps.</p>`
        }
      </div>`;
  }

  private renderReviewTab(): void {
    const packs = this.recordableSessions().filter((s) => !s.active);
    if (packs.length === 0) {
      this.disposeReviewChart();
      this.bodyEl.innerHTML = `
        ${this.renderAlertsHtml()}
        <div class="card ai-train-card">
          <div class="ai-card-head">
            <div>
              <h3 class="ai-card-title">No Stopped Flight Packs to Review Yet</h3>
              <p class="note">Record at least one completed flight pack in Collect (or stop an active Practice session) to inspect its <code>.rfbin</code> signal trace and verify passes.</p>
            </div>
          </div>
          <div class="ai-card-actions">
            <button type="button" class="btn btn-primary" data-ai-tab="collect">Go to Collect</button>
          </div>
        </div>`;
      return;
    }

    let idx = packs.findIndex((s) => s.sessionId === this.reviewSessionId);
    if (idx < 0) {
      const firstUnv = packs.findIndex((s) => !s.trainingVerified);
      idx = firstUnv >= 0 ? firstUnv : 0;
      this.reviewSessionId = packs[idx].sessionId;
      this.reviewEventIdx = 0;
    }
    const sess = packs[idx];
    void this.api.ensurePracticeSessionTrace(sess.sessionId).catch(() => undefined);

    const events = this.computeBorderlineEvents(sess);
    if (this.reviewEventIdx >= events.length) {
      this.reviewEventIdx = Math.max(0, events.length - 1);
    }
    const curEv = events[this.reviewEventIdx] ?? null;
    const validLaps = sess.laps.filter((l) => !l.invalidated).length;
    const gateCount = this.store.practiceSessionNodes(sess).nodes.length;
    const unverifiedRemaining = packs.filter((s) => !s.trainingVerified).length;

    this.disposeReviewChart();

    this.bodyEl.innerHTML = `
      ${this.renderAlertsHtml()}
      <div class="card ai-train-card">
        <div class="ai-review-topbar">
          <div class="ai-review-nav">
            <button type="button" class="btn btn-ghost btn-xs" data-ai-act="prev-pack" ${idx <= 0 ? "disabled" : ""}>${icons.chevronLeft(14)}<span>Prev</span></button>
            <select class="input ai-pack-select" data-ai-review-pack-select aria-label="Select flight pack to review">
              ${packs
                .map((p, pIdx) => {
                  const pLaps = p.laps.filter((l) => !l.invalidated).length;
                  const mark = p.trainingVerified ? "✓" : "•";
                  return `<option value="${esc(p.sessionId)}" ${pIdx === idx ? "selected" : ""}>${mark} ${esc(p.name)} (${pLaps}L · ${p.crossings.length} passes)</option>`;
                })
                .join("")}
            </select>
            <button type="button" class="btn btn-ghost btn-xs" data-ai-act="next-pack" ${idx >= packs.length - 1 ? "disabled" : ""}><span>Next</span>${icons.chevronRight(14)}</button>
          </div>
          <span class="race-state-pill ${sess.trainingVerified ? "is-live" : "is-paused"}">
            ${sess.trainingVerified ? "Verified ✓" : "Unverified"}
          </span>
        </div>

        <div class="ai-review-meta-row">
          <div>
            <strong>${esc(sess.name)}</strong>
            <span class="note"> · Pack ${idx + 1} of ${packs.length} · ${validLaps} laps · ${gateCount} timers · ${sess.crossings.length} passes</span>
          </div>
          <a class="btn btn-ghost btn-xs" href="${esc(buildPracticeHash("session", sess.sessionId))}">
            Open in Practice
          </a>
        </div>

        <div class="rc-signals-chart-host ai-review-chart-host" data-ai-review-chart></div>

        <div class="ai-borderline-box">
          ${
            curEv
              ? `<div class="ai-borderline-head">
                   <div class="ai-borderline-nav">
                     <button type="button" class="btn btn-ghost btn-xs" data-ai-act="prev-event" ${this.reviewEventIdx <= 0 ? "disabled" : ""}>${icons.chevronLeft(13)}</button>
                     <strong>Borderline ${this.reviewEventIdx + 1} / ${events.length}:</strong>
                     <span class="mono">${esc(curEv.gateLabel)} (${esc(curEv.code)}) · ${curEv.peakRssiDbm.toFixed(1)} dBm</span>
                     <button type="button" class="btn btn-ghost btn-xs" data-ai-act="next-event" ${this.reviewEventIdx >= events.length - 1 ? "disabled" : ""}>${icons.chevronRight(13)}</button>
                   </div>
                   <div class="ai-borderline-actions">
                     <button type="button" class="btn btn-ghost btn-xs" data-ai-act="focus-event">Zoom Here</button>
                     ${
                       curEv.kind === "filtered"
                         ? `<button type="button" class="btn btn-primary btn-xs" data-ai-act="promote-event">+ Promote to Pass</button>`
                         : ""
                     }
                     <button type="button" class="btn btn-ghost btn-xs" data-ai-act="dismiss-event">Keep Rejected ✓</button>
                   </div>
                 </div>
                 <div class="note">${esc(curEv.detail)}</div>`
              : `<div class="note">No borderline rejected spikes or out-of-order bumps remaining in this pack. Select any timer chip above and unlock 🔒 if you need to add (+) or remove (×) a crossing manually.</div>`
          }
        </div>

        <div class="ai-review-footer">
          <span class="note">${unverifiedRemaining === 0 ? "All recorded packs verified!" : `${unverifiedRemaining} unverified pack${unverifiedRemaining === 1 ? "" : "s"} remaining`}</span>
          <div class="ai-review-footer-right">
            <button
              type="button"
              class="btn ${sess.trainingVerified ? "btn-ghost" : "btn-primary"}"
              data-ai-act="toggle-verify-pack"
              data-session-id="${esc(sess.sessionId)}"
            >${sess.trainingVerified ? "Unmark Verified" : "✓ Verify Pack & Next"}</button>
            ${
              unverifiedRemaining === 0
                ? `<button type="button" class="btn btn-primary" data-ai-tab="train">Proceed to Train →</button>`
                : ""
            }
          </div>
        </div>
      </div>`;

    const chartHost = this.bodyEl.querySelector<HTMLElement>("[data-ai-review-chart]");
    if (chartHost) {
      this.reviewChartEl = document.createElement("div");
      this.reviewChartEl.className = "rc-signals-chart-inner";
      chartHost.appendChild(this.reviewChartEl);
      this.reviewChartMountedSessionId = sess.sessionId;
      const reviewStore = this.store.forPracticeSessionReview(() =>
        this.store.practiceSessions.find((s) => s.sessionId === this.reviewSessionId)
      );
      const scopedApi =
        typeof this.api.forScope === "function"
          ? this.api.forScope(() => ({ kind: "practice", id: this.reviewSessionId }))
          : this.api;
      this.reviewChart = new PilotRssiChart(this.reviewChartEl, reviewStore, scopedApi);
      const pilotSlot = sess.pilots[0]?.slotIndex ?? 1;
      this.reviewChart.setPilotSlotOverride(pilotSlot);
      if (curEv) {
        this.reviewChart.focusGateAndWindow(curEv.gateId, curEv.timestampUs, 8_000_000, true);
      }
    }
  }

  private renderTrainTab(): void {
    const ml = this.store.mlStatus;
    const packs = this.recordableSessions();
    const unverifiedPacks = packs.filter((s) => !s.trainingVerified && !s.active);
    const activeSess = this.store.activePracticeSession;

    const targetPasses = 250;
    const verifiedPasses = ml.verifiedPasses || 0;
    const readinessPct = Math.min(100, Math.round((verifiedPasses / targetPasses) * 100));

    const models = ml.models ?? [];
    const activeModel: MLModelSummary | undefined =
      models.find((m) => m.modelId === ml.config.activeModelId) ?? models[0];
    const scoreModel: MLModelSummary | undefined = models[0];

    const trainPct =
      ml.training.running && ml.training.totalEpochs > 0
        ? Math.min(100, Math.round((ml.training.epoch / ml.training.totalEpochs) * 100))
        : ml.training.completedModelId
          ? 100
          : 0;

    const scorecardHtml = scoreModel
      ? `
        <div class="ai-scorecard-grid">
          <div class="ai-scorecard-box">
            <div class="ai-scorecard-title">Holdout Validation Scorecard (${esc(scoreModel.name)})</div>
            <div class="table-scroll">
              <table class="table ai-scorecard-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Classic DSP</th>
                    <th>${esc(scoreModel.name)}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Detected Passes</td>
                    <td class="mono">${scoreModel.classicMetrics.detectedPasses} / ${scoreModel.classicMetrics.totalPasses}</td>
                    <td class="mono"><strong>${scoreModel.aiMetrics.detectedPasses} / ${scoreModel.aiMetrics.totalPasses}</strong></td>
                  </tr>
                  <tr>
                    <td>Missed (FN)</td>
                    <td class="mono">${scoreModel.classicMetrics.missedPasses}</td>
                    <td class="mono"><strong>${scoreModel.aiMetrics.missedPasses}</strong></td>
                  </tr>
                  <tr>
                    <td>False Triggers (FP)</td>
                    <td class="mono">${scoreModel.classicMetrics.falseTriggers}</td>
                    <td class="mono"><strong>${scoreModel.aiMetrics.falseTriggers}</strong></td>
                  </tr>
                  <tr>
                    <td>F1 Accuracy</td>
                    <td class="mono">${(scoreModel.classicMetrics.f1 * 100).toFixed(1)}%</td>
                    <td class="mono"><strong>${(scoreModel.aiMetrics.f1 * 100).toFixed(1)}%</strong></td>
                  </tr>
                  <tr>
                    <td>Crest Jitter</td>
                    <td class="mono">±${scoreModel.classicMetrics.meanJitterMs.toFixed(1)} ms</td>
                    <td class="mono"><strong>±${scoreModel.aiMetrics.meanJitterMs.toFixed(1)} ms</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="ai-scorecard-box">
            <div class="ai-scorecard-title">Trained Models</div>
            <div class="ai-model-list">
              ${models
                .map((m) => {
                  const isSel = m.modelId === ml.config.activeModelId && ml.config.detectorMode === "ai";
                  return `
                    <div class="ai-model-row ${isSel ? "is-active" : ""}">
                      <div class="ai-model-meta">
                        <strong>${esc(m.name)}</strong>
                        <span class="note">F1 ${(m.aiMetrics.f1 * 100).toFixed(1)}% · ${m.trainPacks} pack${m.trainPacks === 1 ? "" : "s"}</span>
                      </div>
                      <button
                        type="button"
                        class="btn btn-xs ${isSel ? "btn-primary" : "btn-ghost"}"
                        data-ai-act="activate-model"
                        data-model-id="${esc(m.modelId)}"
                      >${isSel ? "Active ✓" : "Use Model"}</button>
                    </div>`;
                })
                .join("")}
            </div>
            <div class="ai-export-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-ai-act="export-dataset">
                Export Dataset (.tar.gz)
              </button>
              <label class="btn btn-ghost btn-sm ai-import-label">
                <span>Import (.tar.gz)</span>
                <input type="file" accept=".gz,.tgz,application/gzip" data-ai-import-file hidden />
              </label>
            </div>
          </div>
        </div>`
      : "";

    this.bodyEl.innerHTML = `
      ${this.renderAlertsHtml()}

      <div class="card ai-train-card">
        <div class="ai-card-head">
          <div>
            <h3 class="ai-card-title">On-Device Base Model Trainer (Pure Go)</h3>
            <p class="note">Each 4-timer lap yields 4 single-timer passes. Trains a 5,154-parameter 1D dilated TCN locally on this phone or laptop (~5–15s) with 20x RF physics augmentation and an 80/20 pack holdout check.</p>
          </div>
          <span class="mono ai-pass-badge">${verifiedPasses} / ${targetPasses} verified passes</span>
        </div>

        <div class="ai-progress-track">
          <div class="ai-progress-fill" style="width:${readinessPct}%"></div>
        </div>

        <div class="ai-pack-kpis">
          <span><strong>${ml.verifiedPacks}</strong> Verified Packs ✓</span>
          <span><strong>${unverifiedPacks.length}</strong> Unverified Packs</span>
          <span>Trace Storage: <strong>${formatBytesShort(ml.storageBytes)}</strong> (.rfbin)</span>
        </div>

        <div class="ai-card-actions">
          <button
            type="button"
            class="btn btn-primary"
            data-ai-act="train-base-model"
            ${ml.training.running || Boolean(activeSess?.active && !activeSess?.paused) ? "disabled" : ""}
            title="${activeSess?.active && !activeSess?.paused ? "Pause or stop active session before training" : "Train 1D TCN base model on this device"}"
          >${ml.training.running ? "Training..." : "Train Base Model"}</button>
          ${
            unverifiedPacks.length > 0
              ? `<button type="button" class="btn btn-ghost" data-ai-act="review-next-unverified">
                   Review ${unverifiedPacks.length} Unverified Pack${unverifiedPacks.length === 1 ? "" : "s"}
                 </button>`
              : ""
          }
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

      <div class="card ai-train-card">
        <div class="ai-card-head">
          <div>
            <h3 class="ai-card-title">Active Detector for Race &amp; Practice</h3>
            <p class="note">Choose which detector runs live in both <strong>Race</strong> and <strong>Practice</strong> sessions. You can also switch detectors or models anytime inside <strong>Race → Track</strong> or <strong>Practice → Track</strong>.</p>
          </div>
        </div>
        <div class="ai-detector-row">
          <div class="segmented" role="radiogroup" aria-label="Crossing detector engine">
            <button
              type="button"
              class="${ml.config.detectorMode === "classic" ? "is-active" : ""}"
              data-ai-act="set-detector-mode"
              data-mode="classic"
            >Classic DSP</button>
            <button
              type="button"
              class="${ml.config.detectorMode === "ai" ? "is-active" : ""}"
              data-ai-act="set-detector-mode"
              data-mode="ai"
            >AI Detector (v${activeModel?.version ?? 0})</button>
          </div>
          <label class="ai-check-label">
            <input
              type="checkbox"
              data-ai-live-tune
              ${ml.config.liveTuneEnabled ? "checked" : ""}
            />
            <span>Live 2-lap per-timer fine-tuning${(ml.liveTunes?.length ?? 0) > 0 ? ` (${ml.liveTunes!.length} gate${ml.liveTunes!.length === 1 ? "" : "s"} tuned)` : ""}</span>
          </label>
        </div>
      </div>`;
  }

  private readonly handleClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const tabBtn = target.closest<HTMLButtonElement>("[data-ai-tab]");
    if (tabBtn && !tabBtn.disabled) {
      const nextTab = tabBtn.dataset.aiTab as AITrainingTab | undefined;
      if (nextTab === "collect" || nextTab === "review" || nextTab === "train") {
        this.errorMsg = "";
        this.switchTab(nextTab);
      }
      return;
    }

    const btn = target.closest<HTMLButtonElement>("[data-ai-act]");
    if (!btn || btn.disabled) return;

    const act = btn.dataset.aiAct;
    this.errorMsg = "";

    switch (act) {
      case "set-detector-mode": {
        const nextMode = btn.dataset.mode === "ai" ? "ai" : "classic";
        void this.api
          .updateMLConfig({ detectorMode: nextMode })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "activate-model": {
        const modelId = btn.dataset.modelId || "";
        if (!modelId) return;
        void this.api
          .updateMLConfig({ detectorMode: "ai", activeModelId: modelId })
          .then(() => {
            this.statusMsg = `Activated ${modelId} for Race and Practice.`;
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "start-pack-loop": {
        void this.api
          .practiceAction({
            action: "set_pack_loop",
            packLoopEnabled: true,
            preemptOngoing: true,
          })
          .then(() => {
            this.statusMsg = "Hands-Free Pack Loop started. Plug in your quad and fly!";
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "stop-pack-loop": {
        void this.api
          .practiceAction({
            action: "set_pack_loop",
            packLoopEnabled: false,
          })
          .then(() => {
            this.statusMsg = "Hands-Free Pack Loop stopped and active pack sealed.";
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "split-pack-now": {
        void this.api
          .practiceAction({ action: "seal_and_split_pack" })
          .then(() => {
            this.statusMsg = "Sealed current pack and armed next pack.";
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "review-pack": {
        const sid = btn.dataset.sessionId || "";
        if (!sid) return;
        const sess = this.store.practiceSessions.find((s) => s.sessionId === sid);
        if (sess?.active) {
          pushAppHash(buildPracticeHash("session", sid));
          return;
        }
        this.switchTab("review", sid);
        break;
      }
      case "review-next-unverified": {
        const packs = this.recordableSessions().filter((s) => !s.active);
        const unv = packs.find((s) => !s.trainingVerified) ?? packs[packs.length - 1];
        if (!unv) return;
        this.switchTab("review", unv.sessionId);
        break;
      }
      case "prev-pack":
      case "next-pack": {
        const packs = this.recordableSessions().filter((s) => !s.active);
        const curIdx = packs.findIndex((s) => s.sessionId === this.reviewSessionId);
        const nextIdx = act === "prev-pack" ? curIdx - 1 : curIdx + 1;
        if (nextIdx >= 0 && nextIdx < packs.length) {
          this.switchTab("review", packs[nextIdx].sessionId);
        }
        break;
      }
      case "prev-event":
      case "next-event": {
        this.reviewEventIdx += act === "prev-event" ? -1 : 1;
        this.render(true);
        break;
      }
      case "focus-event": {
        const sess = this.store.practiceSessions.find((s) => s.sessionId === this.reviewSessionId);
        if (!sess || !this.reviewChart) return;
        const ev = this.computeBorderlineEvents(sess)[this.reviewEventIdx];
        if (ev) {
          this.reviewChart.focusGateAndWindow(ev.gateId, ev.timestampUs, 6_000_000, true);
        }
        break;
      }
      case "dismiss-event": {
        const sess = this.store.practiceSessions.find((s) => s.sessionId === this.reviewSessionId);
        if (!sess) return;
        const ev = this.computeBorderlineEvents(sess)[this.reviewEventIdx];
        if (ev) {
          this.dismissedEventKeys.add(ev.key);
          this.render(true);
        }
        break;
      }
      case "promote-event": {
        const sess = this.store.practiceSessions.find((s) => s.sessionId === this.reviewSessionId);
        if (!sess) return;
        const ev = this.computeBorderlineEvents(sess)[this.reviewEventIdx];
        if (!ev) return;
        const scopedApi =
          typeof this.api.forScope === "function"
            ? this.api.forScope(() => ({ kind: "practice", id: sess.sessionId }))
            : this.api;
        void scopedApi
          .addCrossing(ev.gateId, ev.slotIndex, ev.timestampUs, ev.peakRssiDbm)
          .then(() => {
            this.dismissedEventKeys.add(ev.key);
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "toggle-verify-pack": {
        const sid = btn.dataset.sessionId || this.reviewSessionId;
        const sess = this.store.practiceSessions.find((s) => s.sessionId === sid);
        if (!sess) return;
        const nextVal = !sess.trainingVerified;
        void this.api
          .practiceAction({
            action: "set_training_verified",
            sessionId: sid,
            trainingVerified: nextVal,
          })
          .then(() => {
            void this.api.fetchMLStatus().catch(() => undefined);
            if (nextVal) {
              const remaining = this.recordableSessions().filter(
                (s) => !s.active && !s.trainingVerified && s.sessionId !== sid
              );
              if (remaining.length > 0) {
                this.switchTab("review", remaining[0].sessionId);
                return;
              }
              this.statusMsg = "All recorded packs verified! Ready to train Base Model.";
              this.switchTab("train");
              return;
            }
            this.render(true);
          })
          .catch((err: unknown) => this.setErr(err));
        break;
      }
      case "train-base-model": {
        this.statusMsg = "";
        void this.api
          .startMLTraining({ epochs: 32, includeUnverified: this.store.mlStatus.verifiedPacks === 0 })
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

  private readonly handleChange = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    if (target instanceof HTMLSelectElement && target.hasAttribute("data-ai-review-pack-select")) {
      const sid = target.value;
      if (sid) {
        this.switchTab("review", sid);
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.hasAttribute("data-ai-live-tune")) {
      void this.api
        .updateMLConfig({ liveTuneEnabled: target.checked })
        .catch((err: unknown) => this.setErr(err));
      return;
    }

    if (target instanceof HTMLSelectElement && target.hasAttribute("data-ai-quiet-sec")) {
      const sec = parseInt(target.value, 10);
      if (Number.isFinite(sec) && sec >= 10) {
        void this.api
          .practiceAction({ action: "set_pack_loop", packLoopQuietSec: sec })
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

  private setErr(err: unknown): void {
    this.errorMsg = err instanceof Error ? err.message : String(err);
    this.render(true);
  }
}
