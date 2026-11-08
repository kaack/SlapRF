import { Component } from "../core/component";
import { esc } from "../core/format";
import { Announcer } from "../services/announcer";
import { isPiperVoiceURI } from "../services/piper_tts";

/** Setup section for the voice announcer. Settings persist in this browser. */
export class AnnouncerSettings extends Component {
  private readonly announcer: Announcer;

  constructor(el: HTMLElement, announcer: Announcer) {
    super(el);
    this.announcer = announcer;
    el.addEventListener("change", this.handleChange);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("click", this.handleClick);
    el.addEventListener("keydown", this.handleKeyDown);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("keydown", this.handleKeyDown);
    });
    this.onDispose(
      announcer.subscribe(() => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.name === "testPhrase" && this.el.contains(active)) {
          return;
        }
        this.render();
      })
    );
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
      case "testPhrase":
        this.announcer.update({ testPhrase: input.value });
        break;
    }
  };

  /** Live readout while dragging a slider (the setting itself is saved on release). */
  private handleInput = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    if (input.name === "testPhrase") return;
    const out = this.el.querySelector<HTMLElement>(`[data-out="${input.name}"]`);
    if (!out) return;
    out.textContent = input.name === "rate" ? `${Number(input.value).toFixed(2)}×` : `${Math.round(Number(input.value) * 100)}%`;
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const input = e.target as HTMLInputElement;
    if (input.name === "testPhrase" && e.key === "Enter") {
      e.preventDefault();
      this.announcer.test(input.value);
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-action=test]")) {
      const phraseInput = this.el.querySelector<HTMLInputElement>('input[name="testPhrase"]');
      this.announcer.test(phraseInput ? phraseInput.value : undefined);
    } else if (target.closest("[data-action=cache-neural]")) {
      void this.announcer.piper.preloadVoice(this.announcer.activeVoiceURI()).catch(() => undefined);
    }
  };

  private render(): void {
    if (!this.announcer.supported) {
      this.el.innerHTML = `<p class="note">This browser doesn't support speech synthesis. Use Chrome, Edge or Safari.</p>`;
      return;
    }
    const p = this.announcer.settings;
    const voices = this.announcer.voices();
    const piperVoices = this.announcer.piperVoices();
    const activeURI = this.announcer.activeVoiceURI();

    const piperGroup = `<optgroup label="Built-in Neural Voices (Offline WASM)">${piperVoices
      .map((v) => {
        const cached = this.announcer.piper.isVoiceCached(v.uri);
        const suffix = cached ? " · ✓ Cached" : "";
        return `<option value="${esc(v.uri)}" ${v.uri === activeURI ? "selected" : ""}>${esc(v.name)}${suffix}</option>`;
      })
      .join("")}</optgroup>`;

    const browserOpts = [`<option value="">System default</option>`]
      .concat(
        voices.map(
          (v) =>
            `<option value="${esc(v.voiceURI)}" ${v.voiceURI === activeURI ? "selected" : ""}>${esc(v.name)} · ${esc(v.lang)}</option>`
        )
      )
      .join("");
    const browserGroup = `<optgroup label="Browser & OS Voices">${browserOpts}</optgroup>`;

    let neuralStatusHtml = "";
    if (isPiperVoiceURI(activeURI)) {
      const dlPct = this.announcer.piper.getDownloadProgress(activeURI);
      const cached = this.announcer.piper.isVoiceCached(activeURI);
      if (dlPct !== null) {
        neuralStatusHtml = `<span class="note">Downloading offline neural voice model… ${dlPct}%</span>`;
      } else if (cached) {
        neuralStatusHtml = `<span class="note">Offline neural voice cached in browser storage (OPFS) ✓</span>`;
      } else {
        neuralStatusHtml = `<button class="btn btn-sm btn-ghost" data-action="cache-neural" type="button">Download for offline use</button>`;
      }
    }

    const defaultSample = this.announcer.defaultTestPhrase();
    const samplePhrase = p.testPhrase !== undefined && p.testPhrase !== "" ? p.testPhrase : defaultSample;

    this.el.innerHTML = `
      <div class="option-row">
        <div>
          <div class="option-title">Voice announcer</div>
          <div class="option-sub">Each time a pilot completes a lap at the start gate it calls their name and lap time — e.g. “Vanover, 14.08”. Built-in Piper neural voices run in WebAssembly and work offline in any browser.</div>
        </div>
        <label class="switch switch-lg"><input type="checkbox" name="enabled" ${p.enabled ? "checked" : ""} /><span></span></label>
      </div>
      <div class="form-grid">
        <label class="field">
          <span>Voice</span>
          <select class="input" name="voice">${piperGroup}${browserGroup}</select>
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
      <div class="check-row" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <input
          class="input"
          type="text"
          name="testPhrase"
          value="${esc(samplePhrase)}"
          placeholder="${esc(defaultSample)}"
          aria-label="Sample voice test sentence"
          style="flex:1 1 220px;max-width:340px;"
        />
        <button class="btn btn-sm" data-action="test" type="button">Test voice</button>
        ${neuralStatusHtml}
      </div>`;
  }
}
