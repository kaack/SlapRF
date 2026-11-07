import { Component } from "../core/component";
import { esc } from "../core/format";
import { Announcer } from "../services/announcer";

/** Setup section for the voice announcer. Settings persist in this browser. */
export class AnnouncerSettings extends Component {
  private readonly announcer: Announcer;

  constructor(el: HTMLElement, announcer: Announcer) {
    super(el);
    this.announcer = announcer;
    el.addEventListener("change", this.handleChange);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(announcer.subscribe(() => this.render()));
    this.render();
  }

  private handleChange = (e: Event): void => {
    const input = e.target as HTMLInputElement | HTMLSelectElement;
    switch (input.name) {
      case "enabled":
        this.announcer.update({ enabled: (input as HTMLInputElement).checked });
        break;
      case "voice":
        this.announcer.update({ voiceURI: input.value });
        break;
      case "rate":
        this.announcer.update({ rate: Number(input.value) });
        break;
      case "volume":
        this.announcer.update({ volume: Number(input.value) });
        break;
    }
  };

  /** Live readout while dragging a slider (the setting itself is saved on release). */
  private handleInput = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    const out = this.el.querySelector<HTMLElement>(`[data-out="${input.name}"]`);
    if (!out) return;
    out.textContent = input.name === "rate" ? `${Number(input.value).toFixed(2)}×` : `${Math.round(Number(input.value) * 100)}%`;
  };

  private handleClick = (e: Event): void => {
    if ((e.target as HTMLElement).closest("[data-action=test]")) this.announcer.test();
  };

  private render(): void {
    if (!this.announcer.supported) {
      this.el.innerHTML = `<p class="note">This browser doesn't support speech synthesis. Use Chrome, Edge or Safari.</p>`;
      return;
    }
    const p = this.announcer.settings;
    const voices = this.announcer.voices();
    const activeURI = this.announcer.resolveVoice()?.voiceURI ?? p.voiceURI;
    const voiceOpts = [`<option value="">System default</option>`]
      .concat(
        voices.map(
          (v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === activeURI ? "selected" : ""}>${esc(v.name)} · ${esc(v.lang)}</option>`
        )
      )
      .join("");

    this.el.innerHTML = `
      <div class="option-row">
        <div>
          <div class="option-title">Voice announcer</div>
          <div class="option-sub">Each time a pilot completes a lap at the start gate it calls their name and lap time — e.g. “Vanover, 14.08”. Plays from this browser, so keep it open on the laptop wired to the PA.</div>
        </div>
        <label class="switch switch-lg"><input type="checkbox" name="enabled" ${p.enabled ? "checked" : ""} /><span></span></label>
      </div>
      <div class="form-grid ${p.enabled ? "" : "is-muted"}">
        <label class="field">
          <span>Voice</span>
          <select class="input" name="voice">${voiceOpts}</select>
        </label>
        <label class="field">
          <span>Speed <em data-out="rate">${p.rate.toFixed(2)}×</em></span>
          <input type="range" name="rate" min="0.8" max="1.6" step="0.05" value="${p.rate}" />
        </label>
        <label class="field">
          <span>Volume <em data-out="volume">${Math.round(p.volume * 100)}%</em></span>
          <input type="range" name="volume" min="0" max="1" step="0.05" value="${p.volume}" />
        </label>
      </div>
      <div class="check-row">
        <button class="btn btn-sm" data-action="test" type="button">Test voice</button>
      </div>`;
  }
}
