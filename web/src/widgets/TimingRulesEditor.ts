import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { gateColor, gateLabel } from "../state/selectors";
import { AppStore } from "../state/store";
import { FilterReason, GatePuck, GateRuleKey, GateRuleOverrides, TimingRules } from "../types/models";
import { FILTER_LABELS } from "./markup";

interface RuleSpec {
  key: keyof TimingRules;
  label: string;
  help: string;
  step: number;
  min: number;
  max: number;
  /** Filter reason this rule produces, to show how often it fired. */
  reason: FilterReason;
  /** Whether a single gate can override it. */
  perGate: boolean;
}

const RULES: RuleSpec[] = [
  {
    key: "minLapSec",
    label: "Minimum lap time",
    help: "Shortest valid time before the same gate can count a pilot again.",
    step: 0.5,
    min: 1,
    max: 120,
    reason: "MIN_LAP",
    perGate: true,
  },
  {
    key: "maxLapSec",
    label: "Maximum lap time",
    help: "Laps longer than this are discarded (crashes, landings, or pack swaps).",
    step: 5,
    min: 10,
    max: 900,
    reason: "LAP_TOO_LONG",
    perGate: false,
  },
  {
    key: "gateCooldownSec",
    label: "Gate cool-down",
    help: "Time a gate ignores a pilot right after counting them.",
    step: 0.1,
    min: 0.2,
    max: 15,
    reason: "COOLDOWN",
    perGate: true,
  },
  {
    key: "minSectionSec",
    label: "Minimum section time",
    help: "Shortest valid transit time from the previous gate.",
    step: 0.1,
    min: 0.1,
    max: 15,
    reason: "TOO_SOON",
    perGate: true,
  },
  {
    key: "echoWindowSec",
    label: "Previous-gate echo window",
    help: "Ignores repeat triggers at the gate a pilot just left (0 disables).",
    step: 0.5,
    min: 0,
    max: 15,
    reason: "ECHO",
    perGate: true,
  },
];

const DEFAULT_RULES: TimingRules = { minLapSec: 5, maxLapSec: 120, gateCooldownSec: 2, minSectionSec: 0.5, echoWindowSec: 3 };

/**
 * Settings section for the detection guardrails. "All gates" edits the global rules; picking a
 * gate lets you override individual rules for just that gate (its position on the track may
 * need, say, a longer echo window). Every change auto-saves immediately.
 */
export class TimingRulesEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  /** null = global rules; otherwise the gate being edited. */
  private scope: number | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    this.listen(el, "change", () => {
      const form = this.el.querySelector<HTMLFormElement>("form.rules");
      if (form) void this.save(form);
    });
    this.listen(el, "keydown", (e) => {
      const target = e.target;
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
      void this.save(e.target as HTMLFormElement);
    });
    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
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
      const scope = target.closest<HTMLElement>("[data-scope]");
      if (scope) {
        this.scope = scope.dataset.scope === "all" ? null : Number(scope.dataset.scope);
        this.render();
        return;
      }
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "defaults") void this.api.updateRules(DEFAULT_RULES);
      if (action === "clear" && this.scope !== null) void this.api.setGateRules(this.scope, {});
    });
    // Re-render on rule / gate changes, unless the user is actively typing in an input.
    this.onDispose(
      store.subscribe(["rules", "config"], () => {
        if (this.scope !== null && !store.puck(this.scope)) this.scope = null;
        const active = document.activeElement;
        const editing = active instanceof HTMLInputElement && this.el.contains(active);
        if (!editing) this.render();
      })
    );
    this.onDispose(store.subscribe(["crossings"], () => this.renderCounts()));
    this.render();
  }

  private overridesOf(p: GatePuck | undefined): GateRuleOverrides {
    return p?.ruleOverrides ?? {};
  }

  private render(): void {
    const r = this.store.rules;
    const gate = this.scope === null ? undefined : this.store.puck(this.scope);
    const overrides = this.overridesOf(gate);

    const scopes = [
      `<button type="button" class="channel channel-all ${this.scope === null ? "is-focus" : "is-dim"}" data-scope="all" title="Global rules for all gates">
        <span class="dot channel-all-dot"></span>
        <span class="channel-name">All gates</span>
        <span class="channel-dbm mono">Global</span>
      </button>`,
      ...this.store.pucks.map((p) => {
        const n = Object.keys(this.overridesOf(p)).length;
        const on = this.scope === p.puckId;
        const dim = this.scope !== null && !on;
        return `<button type="button" class="channel ${on ? "is-focus" : ""} ${dim ? "is-dim" : ""}" data-scope="${p.puckId}"
                  title="${n ? `${n} rule${n > 1 ? "s" : ""} overridden at this gate` : "Uses the global rules"}">
                  <span class="dot" style="--c:${gateColor(this.store, p.puckId)}"></span>
                  <span class="channel-name">${esc(gateLabel(this.store, p.puckId))}</span>
                  <span class="channel-dbm mono">${n ? `<span class="seg-count">${n} custom</span>` : "Default"}</span>
                </button>`;
      }),
    ].join("");

    const rows = RULES.map((spec) => {
      if (gate) return this.renderGateRow(spec, r, overrides);
      const overrideNote = this.renderOverrideNote(spec);
      return `
        <div class="rule-row">
          <div class="rule-text">
            <div class="rule-label">${spec.label}</div>
            <div class="rule-help">${spec.help}</div>
            ${overrideNote}
          </div>
          <span class="rule-count" data-count="${spec.reason}"></span>
          <div class="input-suffix rule-input">
            <input class="input mono" type="number" name="${spec.key}" value="${r[spec.key]}" step="${spec.step}" min="${spec.min}" max="${spec.max}" />
            <span>s</span>
          </div>
          ${overrideNote ? `<div class="rule-mobile-note">${overrideNote}</div>` : ""}
        </div>`;
    }).join("");

    const foot = gate
      ? `<p class="note">Edited rules apply only to ${esc(gateLabel(this.store, gate.puckId))}.</p>
         ${Object.keys(overrides).length ? `<button class="btn btn-ghost btn-sm" type="button" data-action="clear">Use all-gate rules</button>` : ""}`
      : `<p class="note">Applies to new detections.</p>
         <button class="btn btn-ghost btn-sm" type="button" data-action="defaults">Restore defaults</button>`;

    this.el.innerHTML = `
      <div class="rules-scope">
        <span class="rules-scope-label">Applies to</span>
        <div class="channel-legend rules-scope-grid" role="tablist" aria-label="Rules for">${scopes}</div>
      </div>
      <form class="rules">
        ${rows}
        <div class="rules-foot">${foot}</div>
      </form>`;
    this.renderCounts();
  }

  /** A rule for one gate: click the inline pencil icon inside the input to edit/override, or reset icon to revert. */
  private renderGateRow(spec: RuleSpec, r: TimingRules, overrides: GateRuleOverrides): string {
    if (!spec.perGate) {
      return `
        <div class="rule-row is-global-only">
          <div class="rule-text">
            <div class="rule-label">${spec.label}</div>
            <div class="rule-help">Applies to the whole lap, so it's set under All gates.</div>
          </div>
          <span class="rule-count"></span>
          <div class="input-suffix rule-input">
            <input class="input mono" type="number" value="${r[spec.key]}" disabled />
            <span>s</span>
          </div>
        </div>`;
    }
    const key = spec.key as GateRuleKey;
    const own = overrides[key];
    const on = own !== undefined;
    const title = on
      ? `Revert to All gates default (${r[key]} s)`
      : `Edit to override at this gate (inherits ${r[key]} s)`;
    return `
      <div class="rule-row ${on ? "is-overridden" : ""}">
        <div class="rule-text">
          <div class="rule-label">${spec.label}</div>
          <div class="rule-help">${spec.help}</div>
        </div>
        <span class="rule-count" data-count="${spec.reason}"></span>
        <div class="input-suffix rule-input has-inline-action">
          <input class="input mono" type="number" name="${key}" value="${on ? own : r[key]}" step="${spec.step}" min="${spec.min}" max="${spec.max}" ${on ? "" : "disabled"} />
          <span>s</span>
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
      ? `Revert to All gates default (${globalVal} s)`
      : `Edit to override at this gate (inherits ${globalVal} s)`;
    btn.className = `flasher-pass-toggle rule-inline-btn ${on ? "is-active" : ""}`;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML = on ? icons.reset(14) : icons.pencil(14);
  }

  /** On the All gates view, list which gates override this rule. */
  private renderOverrideNote(spec: RuleSpec): string {
    if (!spec.perGate) return "";
    const key = spec.key as GateRuleKey;
    const list = this.store.pucks
      .filter((p) => this.overridesOf(p)[key] !== undefined)
      .map((p) => `${esc(gateLabel(this.store, p.puckId))} ${this.overridesOf(p)[key]} s`);
    return list.length ? `<div class="rule-override-note">Overridden at ${list.join(", ")}</div>` : "";
  }

  private renderCounts(): void {
    const counts = new Map<FilterReason, number>();
    for (const f of this.store.filtered) {
      if (this.scope !== null && f.puckId !== this.scope) continue;
      counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
    }
    const where = this.scope === null ? "" : " here";
    this.el.querySelectorAll<HTMLElement>("[data-count]").forEach((node) => {
      const reason = node.dataset.count as FilterReason;
      const n = counts.get(reason) ?? 0;
      node.textContent = n ? `${n} ${FILTER_LABELS[reason].toLowerCase()}${where} this session` : "";
    });
  }

  private async save(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    if (this.scope === null) {
      const next = { ...this.store.rules };
      for (const spec of RULES) next[spec.key] = Number(data.get(spec.key));
      await this.api.updateRules(next);
      return;
    }
    // Only unlocked/edited rules become overrides (disabled inputs aren't in the form data).
    const overrides: GateRuleOverrides = {};
    for (const spec of RULES) {
      if (!spec.perGate) continue;
      const v = data.get(spec.key);
      if (v !== null && v !== "") overrides[spec.key as GateRuleKey] = Number(v);
    }
    await this.api.setGateRules(this.scope, overrides);
  }
}
