import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  PORTABLE_RELEASES_URL,
  capabilitiesSnapshot,
  orderedPortableAssets,
  subscribeCapabilities,
} from "../services/capabilities";
import { LIVETIME_PORT, LiveTimeRelay, sharedLiveTimeRelay } from "../services/livetime_relay";
import { gateLabel } from "../state/selectors";
import { AppStore } from "../state/store";

/** LiveTime page: built-in LapRF TCP :5403 server status and connection endpoints in SlapRF Portable. */
export class LiveTimeView extends Component {
  private readonly store: AppStore;
  private readonly relay: LiveTimeRelay;

  constructor(el: HTMLElement, store: AppStore, relay: LiveTimeRelay = sharedLiveTimeRelay) {
    super(el);
    this.store = store;
    this.relay = relay;

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest<HTMLButtonElement>("button[data-action='relay-reconnect']");
      if (btn) {
        this.relay.reconnect();
        return;
      }
      const copyBtn = target.closest<HTMLButtonElement>("button[data-copy]");
      if (copyBtn) {
        const text = copyBtn.dataset.copy ?? "";
        void navigator.clipboard?.writeText(text);
        const iconEl = copyBtn.querySelector<HTMLElement>("[data-copy-icon]");
        copyBtn.classList.add("is-copied");
        if (iconEl) iconEl.innerHTML = icons.check(13);
        window.setTimeout(() => {
          copyBtn.classList.remove("is-copied");
          if (iconEl) iconEl.innerHTML = icons.copy(13);
        }, 1400);
      }
    });

    this.listen(el, "change", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-action='toggle-livetime']");
      if (input) this.relay.setEnabled(input.checked);
    });

    this.onDispose(store.subscribe(["status", "config", "laps", "crossings"], () => this.render()));
    this.onDispose(relay.subscribe(() => this.render()));
    this.onDispose(subscribeCapabilities(() => this.render()));
    const tick = window.setInterval(() => this.renderStatusOnly(), 1000);
    this.onDispose(() => window.clearInterval(tick));
    this.render();
  }

  private render(): void {
    const caps = capabilitiesSnapshot();
    if (!caps.portable) {
      const downloads = orderedPortableAssets()
        .map(
          (a) =>
            `<a class="btn btn-sm ${a.recommended ? "" : "btn-ghost"}" href="${PORTABLE_RELEASES_URL}/download/${a.file}" download title="${a.file}">${esc(a.label)}</a>`
        )
        .join("");

      this.el.innerHTML = `
        <div class="settings debug-page">
          <section class="settings-section" data-section-anchor="portable">
            <div class="settings-intro">
              <h2>SlapRF Portable required</h2>
              <p>Browsers cannot open a listening TCP server port directly. Run SlapRF Portable on this computer to expose the built-in LapRF TCP :${LIVETIME_PORT} emulator.</p>
            </div>
            <div class="card">
              <div class="option-row">
                <div>
                  <div class="option-title">Download SlapRF Portable</div>
                  <div class="option-sub">Single standalone executable with the web app, LiveTime TCP :${LIVETIME_PORT} emulator, LapRF Ethernet client, and MultiGP sync built in.</div>
                  <div class="livetime-downloads" style="margin-top:12px;">
                    ${downloads}
                    <a class="link-inline" href="${PORTABLE_RELEASES_URL}" target="_blank" rel="noopener">All releases</a>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>`;
      return;
    }

    const hostPills = ["127.0.0.1", ...caps.lanIPs]
      .map(
        (ip, idx) => `
          <button type="button" class="livetime-copy-pill" data-copy="${esc(ip)}" title="Copy host ${esc(ip)}">
            <span class="muted">${idx === 0 ? "Local" : "LAN"}</span>
            <span>${esc(ip)}</span>
            <span class="livetime-copy-icon" data-copy-icon>${icons.copy(13)}</span>
          </button>`
      )
      .join("");

    this.el.innerHTML = `
      <div class="settings debug-page">
        <section class="settings-section" data-section-anchor="status">
          <div class="settings-intro">
            <h2>Status</h2>
            <p>Live link status between SlapRF Portable's built-in TCP :${LIVETIME_PORT} listener and external race management software.</p>
          </div>
          <div class="debug-status-layout" data-slot="status"></div>
        </section>

        <section class="settings-section" data-section-anchor="connection">
          <div class="settings-intro">
            <h2>Client setup</h2>
            <p>Point MultiGP LiveTime, FPVTrackside, or RotorHazard (LapRF driver) to this computer's IP address and TCP port ${LIVETIME_PORT}.</p>
          </div>
          <div class="card">
            <div class="livetime">
              <div class="option-row" style="border-bottom:0;">
                <div>
                  <div class="option-title">Connection address</div>
                  <div class="option-sub">Use 127.0.0.1 when running timing software on this same computer, or a LAN IP from another computer on the same network.</div>
                  <div class="livetime-downloads" style="margin-top:10px;">
                    ${hostPills}
                    <button type="button" class="livetime-copy-pill" data-copy="${LIVETIME_PORT}" title="Copy port ${LIVETIME_PORT}">
                      <span class="muted">Port</span>
                      <span>${LIVETIME_PORT}</span>
                      <span class="livetime-copy-icon" data-copy-icon>${icons.copy(13)}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>`;

    this.renderStatusOnly();
  }

  private renderStatusOnly(): void {
    const statusSlot = this.el.querySelector<HTMLElement>("[data-slot='status']");
    if (!statusSlot) return;

    const s = this.relay.snapshot;
    const lt = this.store.liveTime;
    const relayUp = s.relayState === "connected";
    const ltUp = relayUp && s.liveTimeState === "connected";

    const topLed = !s.enabled
      ? ""
      : ltUp
        ? "is-up"
        : relayUp || s.relayState === "connecting"
          ? "is-warn"
          : "is-bad";

    const topText = !s.enabled
      ? `LapRF TCP :${LIVETIME_PORT} emulator is off`
      : ltUp
        ? `LapRF client connected (${esc(s.peer || "peer")}) · race ${lt.raceArmedByHost ? "armed" : "stopped"} by host`
        : relayUp
          ? `Listening for LapRF client on TCP :${LIVETIME_PORT}`
          : s.relayState === "connecting"
            ? `Starting TCP :${LIVETIME_PORT} listener…`
            : s.lastError
              ? esc(s.lastError)
              : `TCP :${LIVETIME_PORT} listener inactive`;

    const relayBadge = !s.enabled
      ? `<span class="badge">Disabled</span>`
      : relayUp
        ? `<span class="badge badge-good">Listening</span>`
        : s.relayState === "connecting"
          ? `<span class="badge badge-warn">Starting</span>`
          : `<span class="badge badge-bad">Error</span>`;

    const ltBadge = ltUp
      ? `<span class="badge badge-good">Connected</span>`
      : relayUp
        ? `<span class="badge badge-warn">Waiting</span>`
        : `<span class="badge">Offline</span>`;

    const lastSync =
      lt.lastRfSetupSync && !lt.lastRfSetupSync.startsWith("0001")
        ? new Date(lt.lastRfSetupSync).toLocaleTimeString()
        : "Never";

    const startNode = this.store.nodes.find((n) => n.role === "START_FINISH") ?? this.store.nodes[0];
    const startTimerText = startNode ? gateLabel(this.store, startNode.gateId) : "None";
    const replaced = s.lastError.startsWith("Another SlapRF tab");

    statusSlot.innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${topLed}"></span>
          <span class="debug-head-note">${topText}</span>
        </span>
        <div class="debug-connect-actions">
          <span class="badge">TCP :${LIVETIME_PORT}</span>
          ${
            s.enabled
              ? `<button type="button" class="btn btn-sm btn-ghost" data-action="relay-reconnect" title="Restart TCP listener">
                   ${icons.reset(14)}<span>${replaced ? "Use this tab" : "Reconnect"}</span>
                 </button>`
              : ""
          }
          <label class="switch" title="Enable LapRF TCP :${LIVETIME_PORT} emulator">
            <input type="checkbox" data-action="toggle-livetime" ${s.enabled ? "checked" : ""} />
            <span></span>
          </label>
        </div>
      </div>

      <div class="debug-timer-detail-grid">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${relayUp ? "is-active" : ""}">${icons.plug(14)}<span>Built-in TCP bridge</span></span>
            ${relayBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Status</dt>
              <dd>${
                !s.enabled
                  ? "Disabled"
                  : relayUp
                    ? "Listening on local network"
                    : s.relayState === "connecting"
                      ? "Binding TCP port…"
                      : esc(s.lastError || "Port unavailable")
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Portable version</dt>
              <dd>${s.relayVersion ? esc(s.relayVersion) : esc(capabilitiesSnapshot().version)}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>TCP listener</dt>
              <dd>${relayUp ? esc(s.listenAddr || `0.0.0.0:${LIVETIME_PORT}`) : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Traffic</dt>
              <dd>${s.bytesIn.toLocaleString()} B in · ${s.bytesOut.toLocaleString()} B out</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${ltUp ? "is-active" : ""}">${icons.timer(14)}<span>Connected client</span></span>
            ${ltBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Peer</dt>
              <dd>${ltUp ? esc(s.peer || "Connected") : relayUp ? "Waiting for client" : "Offline"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Race state</dt>
              <dd>${
                ltUp
                  ? lt.raceArmedByHost
                    ? `<span class="badge badge-good">Armed by host</span>`
                    : `<span class="badge">Stopped by host</span>`
                  : "Idle"
              }</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Passings sent</dt>
              <dd>${lt.detectionsSent.toLocaleString()} <span class="note">· start timer ${esc(startTimerText)}</span></dd>
            </div>
            <div class="debug-kv-row">
              <dt>Last RF setup sync</dt>
              <dd>${esc(lastSync)}</dd>
            </div>
          </dl>
        </div>
      </div>`;
  }
}
