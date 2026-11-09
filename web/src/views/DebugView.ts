import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { FIRMWARE_PROFILES } from "../services/esp_flasher";
import { LiveSample, ScanResult, TimerConsole, TimerStatus } from "../services/timer_console";

const RACEBAND = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const DBM_MIN = -100;
const DBM_MAX = -30;
const LOG_LINES = 400;

/**
 * Debug page: connect a timer over USB (WebSerial) and see what it sees. Status, live 5.8 GHz
 * readings per channel, a spectrum scan across 5180-5917 MHz, and the timer's own log.
 */
export class DebugView extends Component {
  private readonly console: TimerConsole;
  private status: TimerStatus | null = null;
  private live: LiveSample | null = null;
  private liveOn = false;
  private logOn = false;
  private scan: ScanResult | null = null;
  private scanning = false;
  private logLines: string[] = [];
  private error: string | null = null;
  private showAllPorts = false;
  private statusTimer = 0;

  constructor(el: HTMLElement) {
    super(el);
    this.console = new TimerConsole({
      onStatus: (s) => {
        this.status = s;
        this.renderStatus();
        this.renderLive();
      },
      onLive: (s) => {
        this.live = s;
        this.renderLive();
      },
      onScan: (s) => {
        this.scan = s;
        this.scanning = false;
        this.renderScan();
      },
      onLog: (line) => this.appendLog(line),
      onConfig: (c) =>
        this.appendLog(
          `[config] ${c.role} "${c.timerLabel}" profile=${c.firmwareProfile} fp=${c.fingerprint} fw=${c.firmwareVersion} ch=${c.frequenciesMHz.join(",")}`
        ),
      onError: (msg) => {
        this.error = msg;
        this.scanning = false;
        this.renderConnection();
        this.renderScan();
      },
      onDisconnect: () => {
        window.clearInterval(this.statusTimer);
        this.liveOn = false;
        this.logOn = false;
        this.renderAll();
      },
    });

    el.innerHTML = `
      <div class="settings debug-page">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Connect a timer</h2>
            <p>Plug a timer into this computer over USB-C. Works with the firmware already on the board; nothing is flashed or changed.</p>
          </div>
          <div class="card" data-slot="connection"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Status</h2>
            <p>Identity, uptime, why it last restarted, memory, sweep timing and the 5.8 GHz receiver's boot check. Refreshes every 2 seconds.</p>
          </div>
          <div class="card" data-slot="status"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Live 5.8 GHz readings</h2>
            <p>What the timer measures on each of its 8 pilot channels, about 10 times a second. The tick marks the peak since the previous update. Power on a VTX to see its channel rise.</p>
          </div>
          <div class="card" data-slot="live"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Spectrum scan</h2>
            <p>Sweeps the receiver across the band. Use it to find a VTX on an unexpected frequency, or to check a venue for 5 GHz Wi-Fi before racing. The timer pauses timing for a fraction of a second while it scans.</p>
          </div>
          <div class="card" data-slot="scan"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Log</h2>
            <p>The timer's own log messages, mirrored over USB while enabled.</p>
          </div>
          <div class="card card-flush" data-slot="log"></div>
        </section>
      </div>`;

    this.listen(el, "click", (e) => void this.onClick(e));
    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-all-ports]")) this.showAllPorts = t.checked;
    });
    this.onDispose(() => {
      window.clearInterval(this.statusTimer);
      void this.console.disconnect();
    });
    this.renderAll();
  }

  private async onClick(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    this.error = null;
    try {
      switch (t.dataset.action) {
        case "connect":
          await this.console.connect(this.showAllPorts);
          this.renderAll();
          await this.console.send("STATUS?");
          this.statusTimer = window.setInterval(() => void this.console.send("STATUS?").catch(() => undefined), 2000);
          this.liveOn = true;
          await this.console.send("LIVE 1");
          this.renderLive();
          break;
        case "disconnect":
          if (this.liveOn) await this.console.send("LIVE 0").catch(() => undefined);
          if (this.logOn) await this.console.send("LOG 0").catch(() => undefined);
          await this.console.disconnect();
          break;
        case "live":
          this.liveOn = !this.liveOn;
          await this.console.send(this.liveOn ? "LIVE 1" : "LIVE 0");
          this.renderLive();
          break;
        case "scan": {
          const start = this.num("[data-scan-start]", 5180);
          const stop = this.num("[data-scan-stop]", 5917);
          const step = this.num("[data-scan-step]", 5);
          this.scanning = true;
          this.renderScan();
          await this.console.send(`SCAN ${start} ${stop} ${step}`);
          break;
        }
        case "log":
          this.logOn = !this.logOn;
          await this.console.send(this.logOn ? "LOG 1" : "LOG 0");
          this.renderLog();
          break;
        case "clear-log":
          this.logLines = [];
          this.renderLog();
          break;
        case "read-config":
          await this.console.send("SLAPRF?");
          break;
        case "reboot":
          if (confirm("Restart the connected timer?")) await this.console.send("REBOOT");
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|cancel/i.test(msg)) this.error = msg;
    }
    this.renderConnection();
  }

  private num(sel: string, fallback: number): number {
    const v = Number(this.el.querySelector<HTMLInputElement>(sel)?.value);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  }

  private renderAll(): void {
    this.renderConnection();
    this.renderStatus();
    this.renderLive();
    this.renderScan();
    this.renderLog();
  }

  private renderConnection(): void {
    const on = this.console.connected;
    const supported = TimerConsole.supported();
    this.slot("connection").innerHTML = `
      <div class="debug-connect">
        <div class="debug-connect-state">
          <span class="status-dot ${on ? "is-up" : ""}"></span>
          <strong>${on ? (this.status ? `Connected to ${esc(this.status.label || "timer")}` : "Connected") : "Not connected"}</strong>
          ${on && this.status ? `<span class="note mono">${esc(this.status.fp)}</span>` : ""}
        </div>
        <div class="debug-connect-actions">
          ${
            on
              ? `<button type="button" class="btn btn-sm btn-ghost" data-action="read-config">Read config</button>
                 <button type="button" class="btn btn-sm btn-ghost" data-action="reboot">${icons.reset(14)}<span>Restart timer</span></button>
                 <button type="button" class="btn btn-sm" data-action="disconnect">Disconnect</button>`
              : `<label class="flasher-port-toggle"><input type="checkbox" data-all-ports ${this.showAllPorts ? "checked" : ""}/><span>Show all USB serial ports</span></label>
                 <button type="button" class="btn btn-armed" data-action="connect" ${supported ? "" : "disabled"}>${icons.plug(15)}<span>Connect over USB</span></button>`
          }
        </div>
      </div>
      ${!supported ? `<p class="note">USB debugging needs Chrome, Edge or Brave (WebSerial).</p>` : ""}
      ${this.error ? `<div class="sim-error-note">${esc(this.error)}</div>` : ""}`;
  }

  private renderStatus(): void {
    const s = this.status;
    if (!s) {
      this.slot("status").innerHTML = `<p class="note">${this.console.connected ? "Waiting for the timer…" : "Connect a timer to see its status."}</p>`;
      return;
    }
    const profile = FIRMWARE_PROFILES.find((p) => p.code === s.profile);
    const budget = s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0;
    const rows: Array<[string, string]> = [
      ["Timer", `${esc(s.label || "(unnamed)")} · ${s.role === 1 ? "Hub" : "Spoke"}${s.slot ? ` · slot ${s.slot}` : ""}`],
      ["Firmware", `${esc(profile?.name ?? `profile ${s.profile}`)} · ${esc(s.fw)}`],
      ["Fingerprint", `<span class="mono">${esc(s.fp)}</span>`],
      ["Uptime", fmtUptime(s.uptimeMs)],
      ["Last restart", esc(s.reset)],
      ["Memory free", `${(s.heapFree / 1024).toFixed(0)} KB <span class="note">(lowest ${(s.heapMin / 1024).toFixed(0)} KB)</span>`],
      ["Sweeps", `${s.sweepHz} Hz · ${(s.sweepUs / 1000).toFixed(2)} ms <span class="note">(slowest ${(s.sweepUsMax / 1000).toFixed(2)} ms of ${(budget / 1000).toFixed(0)} ms)</span>`],
      [
        "5.8 GHz receiver",
        s.rf.ok
          ? `<span class="badge tone-good">OK</span> gain ${s.rf.gain}/${s.rf.gainMax} · floor ${s.rf.floorDb.toFixed(1)} dBm`
          : `<span class="badge tone-bad">Boot check failed</span>`,
      ],
      ["2.4 GHz link", `channel ${s.channel}`],
      ["Channels", `<span class="mono">${s.freqs.join(" · ")}</span> MHz`],
    ];
    this.slot("status").innerHTML = `
      <dl class="debug-status">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      </dl>`;
  }

  private renderLive(): void {
    const freqs = this.status?.freqs ?? RACEBAND;
    const l = this.live;
    const bars = freqs
      .map((f, i) => {
        const v = l?.dbm[i];
        const pk = l?.pk[i];
        const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
        const band = racebandName(f);
        return `
          <div class="debug-bar-row">
            <span class="debug-bar-label mono">${band ? `<strong>${band}</strong> ` : ""}${f}</span>
            <div class="debug-bar-track">
              ${v !== undefined ? `<span class="debug-bar-fill" style="width:${pct(v)}%"></span>` : ""}
              ${pk !== undefined ? `<span class="debug-bar-peak" style="left:${pct(pk)}%"></span>` : ""}
            </div>
            <span class="debug-bar-value mono">${v !== undefined ? `${v} dBm` : "—"}</span>
          </div>`;
      })
      .join("");
    this.slot("live").innerHTML = `
      <div class="debug-card-head">
        <span class="note">${l ? `sweep ${(l.us / 1000).toFixed(2)} ms` : this.console.connected ? "" : "Not connected"}</span>
        <button type="button" class="btn btn-sm ${this.liveOn ? "btn-armed" : "btn-ghost"}" data-action="live" ${this.console.connected ? "" : "disabled"}>
          ${this.liveOn ? icons.pause(14) : icons.play(14)}<span>${this.liveOn ? "Pause" : "Resume"}</span>
        </button>
      </div>
      <div class="debug-bars">${bars}</div>
      <div class="debug-scale mono"><span>${DBM_MIN} dBm</span><span>${DBM_MAX} dBm</span></div>`;
  }

  private renderScan(): void {
    const on = this.console.connected;
    const s = this.scan;
    this.slot("scan").innerHTML = `
      <div class="debug-card-head">
        <div class="debug-scan-inputs">
          <label>From <input class="input mono" type="number" data-scan-start value="5180" min="5180" max="5917"/></label>
          <label>to <input class="input mono" type="number" data-scan-stop value="5917" min="5180" max="5917"/></label>
          <label>step <input class="input mono" type="number" data-scan-step value="5" min="1" max="50"/></label>
          <span class="note">MHz</span>
        </div>
        <button type="button" class="btn btn-sm btn-armed" data-action="scan" ${on && !this.scanning ? "" : "disabled"}>
          ${icons.signal(14)}<span>${this.scanning ? "Scanning…" : "Scan"}</span>
        </button>
      </div>
      ${s ? spectrumSvg(s) : `<p class="note">${on ? "Run a scan to see the band." : "Connect a timer to scan."}</p>`}`;
  }

  private appendLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
    const pre = this.el.querySelector<HTMLElement>("[data-log-pre]");
    if (pre) {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent = this.logLines.join("\n");
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  }

  private renderLog(): void {
    const on = this.console.connected;
    this.slot("log").innerHTML = `
      <div class="debug-card-head debug-log-head">
        <span class="note">${this.logLines.length} lines</span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="clear-log">Clear</button>
          <button type="button" class="btn btn-sm ${this.logOn ? "btn-armed" : "btn-ghost"}" data-action="log" ${on ? "" : "disabled"}>
            ${this.logOn ? "Stop log" : "Start log"}
          </button>
        </div>
      </div>
      <pre class="debug-log mono" data-log-pre>${esc(this.logLines.join("\n"))}</pre>`;
  }
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

function racebandName(f: number): string {
  const i = RACEBAND.indexOf(f);
  return i >= 0 ? `R${i + 1}` : "";
}

/** Line chart of a scan with Raceband channel markers. */
function spectrumSvg(s: ScanResult): string {
  const W = 760;
  const H = 220;
  const L = 44;
  const R = 10;
  const T = 10;
  const B = 28;
  const stop = s.start + s.step * (s.dbm.length - 1);
  const span = Math.max(1, stop - s.start);
  const x = (f: number) => L + ((f - s.start) / span) * (W - L - R);
  const y = (d: number) => T + (1 - (Math.max(DBM_MIN, Math.min(DBM_MAX, d)) - DBM_MIN) / (DBM_MAX - DBM_MIN)) * (H - T - B);
  const pts = s.dbm.map((d, i) => `${x(s.start + i * s.step).toFixed(1)},${y(d).toFixed(1)}`).join(" ");
  const yTicks = [-100, -90, -80, -70, -60, -50, -40, -30];
  const xTicks: number[] = [];
  for (let f = Math.ceil(s.start / 100) * 100; f <= stop; f += 100) xTicks.push(f);
  const peak = s.dbm.reduce((best, d, i) => (d > s.dbm[best] ? i : best), 0);
  return `
    <svg class="debug-spectrum" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Spectrum scan">
      ${yTicks.map((d) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(d)}" y2="${y(d)}"/><text class="axis" x="${L - 6}" y="${y(d) + 3}" text-anchor="end">${d}</text>`).join("")}
      ${xTicks.map((f) => `<text class="axis" x="${x(f)}" y="${H - 8}" text-anchor="middle">${f}</text>`).join("")}
      ${RACEBAND.filter((f) => f >= s.start && f <= stop)
        .map((f, i) => `<line class="band" x1="${x(f)}" x2="${x(f)}" y1="${T}" y2="${H - B}"/><text class="band-label" x="${x(f)}" y="${T + 10}" text-anchor="middle">R${RACEBAND.indexOf(f) + 1}</text>`)
        .join("")}
      <polyline class="trace" points="${pts}"/>
      <circle class="peak" cx="${x(s.start + peak * s.step)}" cy="${y(s.dbm[peak])}" r="3.5"/>
      <text class="peak-label" x="${Math.min(W - R - 4, x(s.start + peak * s.step) + 6)}" y="${Math.max(T + 22, y(s.dbm[peak]) - 6)}">${s.start + peak * s.step} MHz · ${s.dbm[peak]} dBm</text>
    </svg>`;
}
