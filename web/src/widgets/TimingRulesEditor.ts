import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { playSyntheticCrossingBeep } from "../services/crossing_beep";
import { usbPool } from "../services/timer_console";
import { gateColor, gateLabel } from "../state/selectors";
import { AppStore } from "../state/store";
import {
  FilterReason,
  GateRuleKey,
  GateRuleOverrides,
  NumericGateRuleKey,
  TimingRules,
  TrackNode,
} from "../types/models";
import { isTrackTimerActive } from "./TrackEditor";

interface RuleSpec {
  key: NumericGateRuleKey;
  label: string;
  shortLabel: string;
  help: string;
  step: number;
  min: number;
  max: number;
  decimals: number;
  /** Filter reason this rule produces, to show how often it fired. */
  reason: FilterReason;
}

const RULES: RuleSpec[] = [
  {
    key: "minLapSec",
    label: "Minimum lap time (seconds)",
    shortLabel: "Minimum lap time",
    help: "Shortest valid time before the same timer can count a pilot again.",
    step: 0.5,
    min: 1,
    max: 120,
    decimals: 1,
    reason: "MIN_LAP",
  },
  {
    key: "maxLapSec",
    label: "Maximum lap time (seconds)",
    shortLabel: "Maximum lap time",
    help: "Laps longer than this are discarded (crashes, landings, or pack swaps).",
    step: 5,
    min: 10,
    max: 900,
    decimals: 0,
    reason: "LAP_TOO_LONG",
  },
  {
    key: "minCrossingSec",
    label: "Minimum crossing time (seconds)",
    shortLabel: "Minimum crossing time",
    help: "Minimum signal hold duration required across the gate to reject sharp RF or Wi-Fi spikes.",
    step: 0.02,
    min: 0.04,
    max: 1.5,
    decimals: 2,
    reason: "SPIKE",
  },
];

const DEFAULT_RULES: TimingRules = {
  minLapSec: 5,
  maxLapSec: 120,
  minCrossingSec: 0.12,
  beepOnCross: false,
};
const RULES_SCOPE_STORAGE_KEY = "slaprf.ui.rules_scope.v1";

/**
 * Settings section for the detection guardrails. "All timers" edits the global rules; picking a
 * timer lets you override individual rules for just that timer. Every change auto-saves immediately.
 */
export interface TimingRulesEditorOptions {
  readOnly?: () => boolean;
}

export class TimingRulesEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly isReadOnlyFn: () => boolean;
  private readonly bodyEl: HTMLElement;
  private readonly mobileDrawerEl: HTMLElement;
  /** null = track-wide rules; otherwise the gate being edited. */
  private scope: number | null = null;
  private mobileDrawerOpen = false;
  private mobileDrawerClosing = false;
  private mobileDrawerCloseTimer: number | null = null;
  private lastMobileDrawerHtml = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, opts: TimingRulesEditorOptions = {}) {
    super(el);
    this.store = store;
    this.api = api;
    this.isReadOnlyFn = opts.readOnly ?? (() => false);
    el.innerHTML = `
      <div class="rules-editor-body" data-slot="body"></div>
      <div class="scope-tune-drawer is-track-rules-drawer is-mobile-closed" data-slot="mobile-tune-drawer"></div>`;
    this.bodyEl = this.slot("body");
    this.mobileDrawerEl = this.slot("mobile-tune-drawer");
    this.onDispose(() => {
      if (this.mobileDrawerCloseTimer !== null) {
        window.clearTimeout(this.mobileDrawerCloseTimer);
        this.mobileDrawerCloseTimer = null;
      }
    });
    try {
      const savedScope = window.localStorage.getItem(RULES_SCOPE_STORAGE_KEY);
      if (savedScope && savedScope !== "all") {
        const num = Number(savedScope);
        if (Number.isFinite(num) && num >= 1) this.scope = num;
      }
    } catch {
      // Ignore storage access errors
    }
    this.listen(el, "change", (e) => {
      if (this.isReadOnlyFn()) return;
      const target = e.target;
      if (target instanceof HTMLInputElement && target.dataset.tuneInput) {
        const key = target.dataset.tuneInput as NumericGateRuleKey;
        const raw = Number(target.value);
        if (Number.isFinite(raw)) {
          void this.applyTuneRuleValue(key, raw);
        }
        return;
      }
      const form = this.el.querySelector<HTMLFormElement>("form.rules");
      if (form) void this.save(form);
    });
    this.listen(el, "keydown", (e) => {
      const target = e.target;
      if (target instanceof HTMLElement) {
        const dismissEl = target.closest<HTMLElement>("[data-dismiss-gate]");
        if (dismissEl && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.stopPropagation();
          void this.handleDismissGateButton(dismissEl);
          return;
        }
      }
      if (!(target instanceof HTMLInputElement)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        target.blur();
      } else if (e.key === "Escape") {
        target.value = target.defaultValue;
        target.blur();
      }
    });
    this.listen(el, "submit", (e) => {
      e.preventDefault();
      if (this.isReadOnlyFn()) return;
      void this.save(e.target as HTMLFormElement);
    });

    let drawerSwipeStartY: number | null = null;
    this.listen(this.mobileDrawerEl, "pointerdown", (e: PointerEvent) => {
      if (!this.isMobileLayout || !this.mobileDrawerOpen || this.mobileDrawerClosing) return;
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(".scope-tune-mobile-handle-bar, .scope-tune-head")) return;
      if (target.closest("button:not(.pilot-dir-mobile-drawer-handle)")) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      drawerSwipeStartY = e.clientY;
    });
    this.listen(window as unknown as HTMLElement, "pointermove", (e: PointerEvent) => {
      if (drawerSwipeStartY === null) return;
      if (e.clientY - drawerSwipeStartY >= 22) {
        drawerSwipeStartY = null;
        this.dismissMobileDrawer();
      }
    });
    const endDrawerSwipe = () => {
      drawerSwipeStartY = null;
    };
    this.listen(window as unknown as HTMLElement, "pointerup", endDrawerSwipe);
    this.listen(window as unknown as HTMLElement, "pointercancel", endDrawerSwipe);

    // Dismiss mobile drawer when tapping outside the drawer and outside the timer selector boxes
    this.listen(window as unknown as HTMLElement, "pointerdown", (e: PointerEvent) => {
      if (!this.isMobileLayout || !this.mobileDrawerOpen || this.mobileDrawerClosing) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (this.mobileDrawerEl.contains(target) || target.closest("[data-scope]")) return;
      this.dismissMobileDrawer();
    });

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const tuneBtn = target.closest<HTMLElement>(
        "[data-tune-act], [data-tune-step], [data-tune-reset-key]"
      );
      if (tuneBtn && this.mobileDrawerEl.contains(tuneBtn)) {
        if (tuneBtn.dataset.tuneAct === "close") {
          this.dismissMobileDrawer();
          return;
        }
        if (this.isReadOnlyFn()) return;
        if (tuneBtn.dataset.tuneAct === "toggle-beep") {
          this.toggleBeepForCurrentScope();
          return;
        }
        if (tuneBtn.dataset.tuneAct === "reset-beep") {
          this.resetBeepForCurrentScope();
          return;
        }
        if (tuneBtn.dataset.tuneResetKey) {
          void this.resetSingleTuneRule(tuneBtn.dataset.tuneResetKey as NumericGateRuleKey);
          return;
        }
        if (tuneBtn.dataset.tuneStep && tuneBtn.dataset.tuneKey) {
          const dir = Number(tuneBtn.dataset.tuneStep);
          const key = tuneBtn.dataset.tuneKey as NumericGateRuleKey;
          void this.stepTuneRule(key, dir);
          return;
        }
      }

      const dismissBtn = target.closest<HTMLElement>("[data-dismiss-gate]");
      if (dismissBtn) {
        e.preventDefault();
        e.stopPropagation();
        void this.handleDismissGateButton(dismissBtn);
        return;
      }

      const scope = target.closest<HTMLElement>("[data-scope]");
      if (scope) {
        const nextScope = scope.dataset.scope === "all" ? null : Number(scope.dataset.scope);
        if (this.isMobileLayout) {
          if (this.mobileDrawerOpen && !this.mobileDrawerClosing && this.scope === nextScope) {
            this.dismissMobileDrawer();
            return;
          }
          if (this.mobileDrawerCloseTimer !== null) {
            window.clearTimeout(this.mobileDrawerCloseTimer);
            this.mobileDrawerCloseTimer = null;
          }
          this.mobileDrawerClosing = false;
          this.mobileDrawerEl.classList.remove("is-closing");
          this.mobileDrawerOpen = true;
        }
        this.scope = nextScope;
        try {
          window.localStorage.setItem(RULES_SCOPE_STORAGE_KEY, this.scope === null ? "all" : String(this.scope));
        } catch {
          // Ignore storage access errors
        }
        this.render();
        return;
      }
      if (this.isReadOnlyFn()) return;
      const resetGlobalBtn = target.closest<HTMLButtonElement>("[data-reset-global]");
      if (resetGlobalBtn) {
        const key = resetGlobalBtn.dataset.resetGlobal as keyof TimingRules;
        if (key in DEFAULT_RULES) {
          void this.api.updateRules({ ...this.store.rules, [key]: DEFAULT_RULES[key] });
        }
        return;
      }
      const beepToggleBtn = target.closest<HTMLButtonElement>("[data-beep-toggle]");
      if (beepToggleBtn) {
        this.toggleBeepForCurrentScope();
        return;
      }
      const beepResetBtn = target.closest<HTMLButtonElement>("[data-beep-reset]");
      if (beepResetBtn) {
        this.resetBeepForCurrentScope();
        return;
      }
      const toggleBtn = target.closest<HTMLButtonElement>("[data-override-toggle]");
      if (toggleBtn) {
        const key = toggleBtn.dataset.overrideToggle as GateRuleKey;
        const row = toggleBtn.closest<HTMLElement>(".rule-row");
        const input = row?.querySelector<HTMLInputElement>(`input[name="${key}"]`);
        const form = this.el.querySelector<HTMLFormElement>("form.rules");
        if (row && input && form) {
          const nextOn = input.disabled;
          input.disabled = !nextOn;
          row.classList.toggle("is-overridden", nextOn);
          if (!nextOn) {
            input.value = String(this.store.rules[key]);
          } else {
            input.focus();
            input.select();
          }
          this.syncToggleBtn(toggleBtn, nextOn, this.store.rules[key]);
          void this.save(form);
        }
        return;
      }
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "defaults") void this.api.updateRules(DEFAULT_RULES);
      if (action === "clear" && this.scope !== null) {
        const targetGate = this.scope;
        this.scope = null;
        try {
          window.localStorage.setItem(RULES_SCOPE_STORAGE_KEY, "all");
        } catch {
          // Ignore storage access errors
        }
        void this.api.setGateRules(targetGate, {});
        this.render();
      }
    });
    // Re-render on rule / gate / session / race changes, unless the user is actively typing in an input.
    const refreshIfIdle = () => {
      if (this.scope !== null && !store.node(this.scope)) {
        this.scope = null;
        if (this.mobileDrawerOpen) {
          this.mobileDrawerOpen = false;
          this.mobileDrawerClosing = false;
          this.mobileDrawerEl.classList.remove("is-closing");
          this.mobileDrawerEl.classList.add("is-mobile-closed");
        }
      }
      const active = document.activeElement;
      const editing = active instanceof HTMLInputElement && this.el.contains(active);
      if (!editing) this.render();
    };
    this.onDispose(store.subscribe(["rules", "config", "status", "practice", "race"], refreshIfIdle));
    const unsubPool = usbPool.onChange(refreshIfIdle);
    const unsubSlots = usbPool.slots.map((c) =>
      c.subscribe({
        onConnect: refreshIfIdle,
        onStatus: refreshIfIdle,
        onDisconnect: refreshIfIdle,
      })
    );
    this.onDispose(() => {
      unsubPool();
      unsubSlots.forEach((fn) => fn());
    });
    this.listen(window, "resize", () => this.syncScopeLayout());
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.syncScopeLayout());
      ro.observe(this.el);
      this.onDispose(() => ro.disconnect());
    }
    this.render();
  }

  private get isMobileLayout(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  }

  private overridesOf(p: TrackNode | undefined): GateRuleOverrides {
    return p?.ruleOverrides ?? {};
  }

  private formatTuneVal(val: number, decimals: number): string {
    if (decimals <= 0) return String(Math.round(val));
    const fixed = val.toFixed(decimals);
    return fixed.replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");
  }

  private toggleBeepForCurrentScope(): void {
    if (this.scope === null) {
      const nextBeep = !this.store.rules.beepOnCross;
      if (nextBeep && this.store.nodes[0]) {
        playSyntheticCrossingBeep(this.store, this.store.nodes[0].gateId);
      }
      void this.api.updateRules({ ...this.store.rules, beepOnCross: nextBeep });
    } else {
      const curGate = this.store.node(this.scope);
      const curOvr = { ...this.overridesOf(curGate) };
      const globalBeep = Boolean(this.store.rules.beepOnCross);
      const curEff = curOvr.beepOnCross !== undefined ? curOvr.beepOnCross : globalBeep;
      const nextBeep = !curEff;
      if (nextBeep) {
        playSyntheticCrossingBeep(this.store, this.scope);
      }
      curOvr.beepOnCross = nextBeep;
      void this.api.setGateRules(this.scope, curOvr);
    }
  }

  private resetBeepForCurrentScope(): void {
    if (this.scope === null) {
      void this.api.updateRules({ ...this.store.rules, beepOnCross: false });
    } else {
      const nextOvr = { ...this.overridesOf(this.store.node(this.scope)) };
      delete nextOvr.beepOnCross;
      void this.api.setGateRules(this.scope, nextOvr);
    }
  }

  private async applyTuneRuleValue(key: NumericGateRuleKey, rawVal: number): Promise<void> {
    if (this.isReadOnlyFn()) return;
    const spec = RULES.find((s) => s.key === key);
    if (!spec) return;
    const clamped = Math.max(spec.min, Math.min(spec.max, Number(rawVal.toFixed(spec.decimals + 1))));
    if (this.scope === null) {
      await this.api.updateRules({ ...this.store.rules, [key]: clamped });
      return;
    }
    const nextOverrides: GateRuleOverrides = {
      ...this.overridesOf(this.store.node(this.scope)),
      [key]: clamped,
    };
    await this.api.setGateRules(this.scope, nextOverrides);
  }

  private async stepTuneRule(key: NumericGateRuleKey, dir: number): Promise<void> {
    if (this.isReadOnlyFn()) return;
    const spec = RULES.find((s) => s.key === key);
    if (!spec) return;
    const gate = this.scope === null ? undefined : this.store.node(this.scope);
    const ovr = this.overridesOf(gate);
    const curVal = gate && ovr[key] !== undefined ? ovr[key]! : this.store.rules[key];
    await this.applyTuneRuleValue(key, curVal + dir * spec.step);
  }

  private async resetSingleTuneRule(key: NumericGateRuleKey): Promise<void> {
    if (this.isReadOnlyFn()) return;
    if (this.scope === null) {
      await this.api.updateRules({ ...this.store.rules, [key]: DEFAULT_RULES[key] });
      return;
    }
    const nextOverrides: GateRuleOverrides = {
      ...this.overridesOf(this.store.node(this.scope)),
    };
    delete nextOverrides[key];
    await this.api.setGateRules(this.scope, nextOverrides);
  }

  private dismissMobileDrawer(): void {
    if (!this.mobileDrawerOpen || this.mobileDrawerClosing) return;
    if (!this.isMobileLayout) {
      this.mobileDrawerOpen = false;
      this.render();
      return;
    }
    this.mobileDrawerClosing = true;
    this.mobileDrawerEl.classList.add("is-closing");
    this.syncScopeFocusClasses();
    if (this.mobileDrawerCloseTimer !== null) {
      window.clearTimeout(this.mobileDrawerCloseTimer);
    }
    this.mobileDrawerCloseTimer = window.setTimeout(() => {
      this.mobileDrawerCloseTimer = null;
      if (!this.mobileDrawerClosing) return;
      this.mobileDrawerClosing = false;
      this.mobileDrawerEl.classList.remove("is-closing");
      this.mobileDrawerOpen = false;
      this.renderMobileDrawer();
      this.syncScopeFocusClasses();
    }, 200);
  }

  private syncScopeFocusClasses(): void {
    const showActive = !this.isMobileLayout || (this.mobileDrawerOpen && !this.mobileDrawerClosing);
    const btns = this.bodyEl.querySelectorAll<HTMLElement>(".rules-scope-grid > [data-scope]");
    btns.forEach((btn) => {
      const isTarget =
        btn.dataset.scope === "all"
          ? this.scope === null
          : Number(btn.dataset.scope) === this.scope;
      btn.classList.toggle("is-focus", showActive && isTarget);
      btn.classList.toggle("is-dim", showActive && !isTarget);
    });
  }

  private async handleDismissGateButton(btn: HTMLElement): Promise<void> {
    if (this.isReadOnlyFn()) return;
    const gateId = Number(btn.dataset.dismissGate);
    const timerId = Number(btn.dataset.dismissTimer || "0");
    const fp = btn.dataset.dismissFp || "";
    const label = btn.dataset.dismissLabel || "";
    if (this.scope === gateId) {
      this.scope = null;
      try {
        window.localStorage.setItem(RULES_SCOPE_STORAGE_KEY, "all");
      } catch {
        // Ignore storage access errors
      }
      if (this.mobileDrawerOpen) {
        this.mobileDrawerOpen = false;
        this.mobileDrawerClosing = false;
        this.mobileDrawerEl.classList.remove("is-closing");
        this.mobileDrawerEl.classList.add("is-mobile-closed");
      }
    }
    if (timerId > 0) {
      await this.api.deleteTimer(timerId, fp, label);
    } else if (gateId > 0) {
      await this.api.removeTrackNode(gateId);
    }
  }

  private render(): void {
    const r = this.store.rules;
    const gate = this.scope === null ? undefined : this.store.node(this.scope);
    const overrides = this.overridesOf(gate);
    const readOnly = this.isReadOnlyFn();

    let globalOvrCount = r.beepOnCross ? 1 : 0;
    for (const s of RULES) {
      if (Math.abs(r[s.key] - DEFAULT_RULES[s.key]) > 1e-6) globalOvrCount++;
    }

    const showActive = !this.isMobileLayout || (this.mobileDrawerOpen && !this.mobileDrawerClosing);
    const allFocus = showActive && this.scope === null;
    const allDim = showActive && this.scope !== null;

    const scopes = [
      `<button type="button" class="channel channel-all ${allFocus ? "is-focus" : ""} ${allDim ? "is-dim" : ""}" data-scope="all" title="Global rules for all timers">
        <span class="dot channel-all-dot"></span>
        <span class="channel-name">All timers</span>
        ${globalOvrCount > 0 ? `<span class="channel-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>` : ""}
      </button>`,
      ...this.store.nodes.map((p) => {
        const ovr = this.overridesOf(p);
        let n = ovr.beepOnCross !== undefined ? 1 : 0;
        for (const s of RULES) {
          if (ovr[s.key] !== undefined) n++;
        }
        const assignedId = p.assignedTimerId ?? 0;
        const tiedTimer = assignedId > 0 ? this.store.detectedTimers.find((d) => d.timerId === assignedId) : undefined;
        const isOnline = assignedId > 0 ? isTrackTimerActive(this.store, tiedTimer, p) : false;
        const canDismiss = !isOnline && !readOnly;
        const label = gateLabel(this.store, p.gateId);
        const on = showActive && this.scope === p.gateId;
        const dim = showActive && this.scope !== p.gateId;
        return `<button type="button" class="channel ${on ? "is-focus" : ""} ${dim ? "is-dim" : ""} ${canDismiss ? "has-dismiss" : ""}" data-scope="${p.gateId}"
                  title="${n ? `${n} rule${n > 1 ? "s" : ""} overridden at this timer` : "Uses the global rules"}">
                  <span class="dot" style="--c:${gateColor(this.store, p.gateId)}"></span>
                  <span class="channel-name">${esc(label)}</span>
                  ${n ? `<span class="channel-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>` : ""}
                  ${
                    canDismiss
                      ? `<span
                          role="button"
                          tabindex="0"
                          class="channel-dismiss-btn"
                          data-dismiss-gate="${p.gateId}"
                          data-dismiss-timer="${assignedId}"
                          data-dismiss-fp="${esc(tiedTimer?.fingerprint || "")}"
                          data-dismiss-label="${esc(label)}"
                          title="Remove disconnected timer ${esc(label)}"
                          aria-label="Remove disconnected timer ${esc(label)}"
                        >${icons.close(13)}</span>`
                      : ""
                  }
                </button>`;
      }),
    ].join("");

    const rows = RULES.map((spec) => {
      if (gate) return this.renderGateRow(spec, r, overrides);
      const defVal = DEFAULT_RULES[spec.key];
      const isCustom = Math.abs(r[spec.key] - defVal) > 1e-6;
      return `
        <div class="rule-row ${isCustom ? "is-overridden" : ""}">
          <div class="rule-text">
            <div class="rule-label">${spec.label}</div>
            <div class="rule-help">${spec.help}</div>
          </div>
          <div class="flasher-pass-wrap rule-input ${isCustom ? "has-inline-action" : ""}">
            <input class="input mono ${isCustom ? "flasher-pass-input" : ""}" type="number" name="${spec.key}" value="${r[spec.key]}" step="${spec.step}" min="${spec.min}" max="${spec.max}" />
            ${
              isCustom
                ? `<button class="flasher-pass-toggle rule-inline-btn is-active" type="button" data-reset-global="${spec.key}" title="Restore default (${defVal} s)" aria-label="Restore default (${defVal} s)">${icons.reset(14)}</button>`
                : ""
            }
          </div>
        </div>`;
    }).join("");

    const beepRow = gate
      ? this.renderGateBeepRow(r, overrides)
      : this.renderGlobalBeepRow(r);

    const foot = readOnly
      ? `<p class="note">Recorded timing rules for this closed race · reopen the race to modify rules.</p>`
      : gate
        ? `<p class="note">Edited rules apply only to ${esc(gateLabel(this.store, gate.gateId))}.</p>
           <button class="btn btn-ghost btn-sm" type="button" data-action="clear">Restore defaults</button>`
        : `<p class="note">Applies to new detections on this track.</p>
           <button class="btn btn-ghost btn-sm" type="button" data-action="defaults">Restore defaults</button>`;

    this.bodyEl.innerHTML = `
      <div class="rules-scope">
        <div class="channel-legend rules-scope-grid" role="tablist" aria-label="Rules for">${scopes}</div>
      </div>
      <form class="rules ${readOnly ? "is-readonly-rules" : ""}">
        <fieldset ${readOnly ? "disabled" : ""} style="border:0;margin:0;padding:0;min-width:0;display:contents">
          ${rows}
          ${beepRow}
          <div class="rules-foot">${foot}</div>
        </fieldset>
      </form>`;
    this.renderMobileDrawer();
    this.syncScopeLayout();
  }

  private renderMobileDrawer(): void {
    const drawerEl = this.mobileDrawerEl;
    if (this.mobileDrawerClosing) return;

    drawerEl.classList.toggle("is-mobile-closed", !this.mobileDrawerOpen);
    if (this.mobileDrawerOpen && this.isMobileLayout) {
      this.syncMobileDrawerTop(drawerEl);
    }

    const r = this.store.rules;
    const gate = this.scope === null ? undefined : this.store.node(this.scope);
    const isGlobalScope = !gate;
    const gateName = gate ? gateLabel(this.store, gate.gateId) : "All timers";
    const color = gate ? gateColor(this.store, gate.gateId) : "";
    const activeOverrides = this.overridesOf(gate);
    const readOnly = this.isReadOnlyFn();
    const disAttr = readOnly ? "disabled" : "";

    const beepOverridden = isGlobalScope
      ? Boolean(r.beepOnCross) !== Boolean(DEFAULT_RULES.beepOnCross)
      : activeOverrides.beepOnCross !== undefined;
    const beepEffOn = isGlobalScope
      ? Boolean(r.beepOnCross)
      : activeOverrides.beepOnCross !== undefined
        ? Boolean(activeOverrides.beepOnCross)
        : Boolean(r.beepOnCross);

    const beepCardHtml = `
      <div class="scope-tune-card is-beep-card ${beepOverridden ? "is-overridden" : ""}" data-tune-card="beepOnCross">
        <div class="scope-tune-card-info">
          <div class="scope-tune-card-title-row">
            <span class="scope-tune-card-label">Beep on crossing</span>
            ${
              beepOverridden
                ? `<span class="scope-tune-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>`
                : ""
            }
          </div>
          <div class="scope-tune-card-help">Plays an instant high-priority synthetic tone when a crossing is detected ${isGlobalScope ? "for all timers" : "at this timer"}.</div>
        </div>
        <div class="scope-tune-card-controls">
          <div class="scope-tune-switch-slot">
            <button
              type="button"
              role="switch"
              aria-checked="${beepEffOn}"
              class="scope-tune-switch ${beepEffOn ? "is-on" : ""}"
              data-tune-act="toggle-beep"
              aria-label="Beep on crossing"
              ${disAttr}
            >
              <span class="scope-tune-switch-track"><span class="scope-tune-switch-thumb"></span></span>
            </button>
          </div>
          ${
            beepOverridden && !readOnly
              ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-tune-act="reset-beep" title="Restore default Beep on crossing" aria-label="Restore default Beep on crossing">${icons.reset(13)}</button>`
              : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
          }
        </div>
      </div>`;

    const cardsHtml = RULES.map((spec) => {
      const isOverridden = isGlobalScope
        ? Math.abs(r[spec.key] - DEFAULT_RULES[spec.key]) > 1e-6
        : activeOverrides[spec.key] !== undefined;
      const curVal =
        !isGlobalScope && activeOverrides[spec.key] !== undefined
          ? activeOverrides[spec.key]!
          : r[spec.key];
      const valStr = this.formatTuneVal(curVal, spec.decimals);
      return `
        <div class="scope-tune-card ${isOverridden ? "is-overridden" : ""}" data-tune-card="${spec.key}">
          <div class="scope-tune-card-info">
            <div class="scope-tune-card-title-row">
              <span class="scope-tune-card-label">${esc(spec.shortLabel)}</span>
              ${
                isOverridden
                  ? `<span class="scope-tune-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>`
                  : ""
              }
            </div>
            <div class="scope-tune-card-help">${esc(spec.help)}</div>
          </div>
          <div class="scope-tune-card-controls">
            <div class="scope-tune-stepper">
              <button type="button" class="scope-tune-step-btn" data-tune-step="-1" data-tune-key="${spec.key}" title="Decrease ${esc(spec.shortLabel)}" aria-label="Decrease ${esc(spec.shortLabel)}" ${disAttr}>${icons.minus(12)}</button>
              <div class="scope-tune-input-wrap">
                <input
                  class="input mono scope-tune-input"
                  type="number"
                  data-tune-input="${spec.key}"
                  value="${valStr}"
                  step="${spec.step}"
                  min="${spec.min}"
                  max="${spec.max}"
                  aria-label="${esc(spec.shortLabel)} in seconds"
                  ${disAttr}
                />
                <span class="scope-tune-unit">s</span>
              </div>
              <button type="button" class="scope-tune-step-btn" data-tune-step="1" data-tune-key="${spec.key}" title="Increase ${esc(spec.shortLabel)}" aria-label="Increase ${esc(spec.shortLabel)}" ${disAttr}>${icons.plus(12)}</button>
            </div>
            ${
              isOverridden && !readOnly
                ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-tune-reset-key="${spec.key}" title="Restore default ${esc(spec.shortLabel)}" aria-label="Restore default ${esc(spec.shortLabel)}">${icons.reset(13)}</button>`
                : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
            }
          </div>
        </div>`;
    }).join("");

    const headDotHtml = isGlobalScope
      ? `<span class="dot channel-all-dot"></span>`
      : `<span class="dot" style="--c:${color}"></span>`;

    const nextHtml = `
      <div class="dir-mobile-drawer-top-bar scope-tune-mobile-handle-bar">
        <button
          type="button"
          class="pilot-dir-mobile-drawer-handle"
          data-tune-act="close"
          title="Close fine-tuning drawer"
          aria-label="Close fine-tuning drawer"
        >
          <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
        </button>
      </div>
      <div class="scope-tune-head">
        <div class="scope-tune-title-group">
          ${headDotHtml}
          <strong>${esc(gateName)} · Fine-tune</strong>
        </div>
        <div class="scope-tune-head-actions">
          ${readOnly ? `<span class="badge">Locked</span>` : ""}
        </div>
      </div>
      <div class="scope-tune-grid">
        ${cardsHtml}
        ${beepCardHtml}
      </div>`;

    if (nextHtml !== this.lastMobileDrawerHtml) {
      this.lastMobileDrawerHtml = nextHtml;
      drawerEl.innerHTML = nextHtml;
    }
  }

  /** Anchors the mobile bottom drawer right below the top Track card so the Track card stays visible. */
  private syncMobileDrawerTop(drawerEl: HTMLElement): void {
    const trackCard =
      this.el.closest(".scoped-track-workspace")?.querySelector<HTMLElement>('[data-slot="track"]') ??
      document.querySelector<HTMLElement>('.scoped-track-workspace [data-slot="track"]');
    if (trackCard) {
      const rect = trackCard.getBoundingClientRect();
      if (rect.bottom > 80) {
        drawerEl.style.setProperty("--scope-graph-bottom", `${Math.ceil(rect.bottom + 8)}px`);
        return;
      }
    }
    drawerEl.style.removeProperty("--scope-graph-bottom");
  }

  /**
   * On mobile (<= 860px), keep all timer selector boxes in one horizontal row when they fit,
   * and stack them vertically at full width when they would overflow or wrap onto multiple rows.
   */
  private syncScopeLayout(): void {
    const grid = this.el.querySelector<HTMLElement>(".rules-scope-grid");
    if (!grid) return;
    const isMobile = this.isMobileLayout;
    if (!isMobile) {
      grid.classList.remove("is-mobile-stacked");
      if (this.mobileDrawerOpen || this.mobileDrawerClosing) {
        this.mobileDrawerOpen = false;
        this.mobileDrawerClosing = false;
        this.mobileDrawerEl.classList.remove("is-closing");
        this.mobileDrawerEl.classList.add("is-mobile-closed");
      }
      this.syncScopeFocusClasses();
      return;
    }
    if (this.mobileDrawerOpen && !this.mobileDrawerClosing) {
      this.syncMobileDrawerTop(this.mobileDrawerEl);
    }
    this.syncScopeFocusClasses();
    grid.classList.add("is-mobile-stacked");
  }

  private renderGlobalBeepRow(r: TimingRules): string {
    const isOn = Boolean(r.beepOnCross);
    return `
      <div class="rule-row ${isOn ? "is-overridden" : ""}">
        <div class="rule-text">
          <div class="rule-label">Beep on crossing</div>
          <div class="rule-help">Plays an instant high-priority synthetic tone when a crossing is detected for all timers.</div>
        </div>
        <div class="rule-input rule-switch-wrap">
          <button
            type="button"
            role="switch"
            aria-checked="${isOn}"
            class="scope-tune-switch ${isOn ? "is-on" : ""}"
            data-beep-toggle
            aria-label="Beep on crossing"
          >
            <span class="scope-tune-switch-track"><span class="scope-tune-switch-thumb"></span></span>
          </button>
          ${
            isOn
              ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-beep-reset title="Restore default (OFF)" aria-label="Restore default Beep on crossing">${icons.reset(13)}</button>`
              : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
          }
        </div>
      </div>`;
  }

  private renderGateBeepRow(r: TimingRules, overrides: GateRuleOverrides): string {
    const hasOwn = overrides.beepOnCross !== undefined;
    const effOn = hasOwn ? Boolean(overrides.beepOnCross) : Boolean(r.beepOnCross);
    return `
      <div class="rule-row ${hasOwn ? "is-overridden" : ""}">
        <div class="rule-text">
          <div class="rule-label">Beep on crossing</div>
          <div class="rule-help">Plays an instant high-priority synthetic tone when a crossing is detected at this timer.</div>
        </div>
        <div class="rule-input rule-switch-wrap">
          <button
            type="button"
            role="switch"
            aria-checked="${effOn}"
            class="scope-tune-switch ${effOn ? "is-on" : ""}"
            data-beep-toggle
            aria-label="Beep on crossing"
          >
            <span class="scope-tune-switch-track"><span class="scope-tune-switch-thumb"></span></span>
          </button>
          ${
            hasOwn
              ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-beep-reset title="Restore default Beep on crossing" aria-label="Restore default Beep on crossing">${icons.reset(13)}</button>`
              : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
          }
        </div>
      </div>`;
  }

  /** A rule for one timer: click the inline pencil icon inside the input to edit/override, or reset icon to revert. */
  private renderGateRow(spec: RuleSpec, r: TimingRules, overrides: GateRuleOverrides): string {
    const key = spec.key;
    const own = overrides[key];
    const on = own !== undefined;
    const title = on
      ? `Revert to All timers default (${r[key]} s)`
      : `Edit to override at this timer (inherits ${r[key]} s)`;
    return `
      <div class="rule-row ${on ? "is-overridden" : ""}">
        <div class="rule-text">
          <div class="rule-label">${spec.label}</div>
          <div class="rule-help">${spec.help}</div>
        </div>
        <div class="flasher-pass-wrap rule-input has-inline-action">
          <input class="input mono flasher-pass-input" type="number" name="${key}" value="${on ? own : r[key]}" step="${spec.step}" min="${spec.min}" max="${spec.max}" ${on ? "" : "disabled"} />
          <button
            class="flasher-pass-toggle rule-inline-btn ${on ? "is-active" : ""}"
            type="button"
            data-override-toggle="${key}"
            title="${title}"
            aria-label="${title}"
            aria-pressed="${on}"
          >
            ${on ? icons.reset(14) : icons.pencil(14)}
          </button>
        </div>
      </div>`;
  }

  private syncToggleBtn(btn: HTMLButtonElement, on: boolean, globalVal: number): void {
    const title = on
      ? `Revert to All timers default (${globalVal} s)`
      : `Edit to override at this timer (inherits ${globalVal} s)`;
    btn.className = `flasher-pass-toggle rule-inline-btn ${on ? "is-active" : ""}`;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML = on ? icons.reset(14) : icons.pencil(14);
  }

  private async save(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    if (this.scope === null) {
      const next = { ...this.store.rules };
      for (const spec of RULES) {
        const raw = data.get(spec.key);
        if (raw !== null && raw !== "") next[spec.key] = Number(raw);
      }
      await this.api.updateRules(next);
      return;
    }
    // Only unlocked/edited rules become overrides (disabled inputs aren't in the form data).
    const prevOvr = this.overridesOf(this.store.node(this.scope));
    const overrides: GateRuleOverrides = {};
    if (prevOvr.beepOnCross !== undefined) {
      overrides.beepOnCross = prevOvr.beepOnCross;
    }
    for (const spec of RULES) {
      const v = data.get(spec.key);
      if (v !== null && v !== "") overrides[spec.key] = Number(v);
    }
    await this.api.setGateRules(this.scope, overrides);
  }
}
