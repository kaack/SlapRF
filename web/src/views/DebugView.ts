import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { FIRMWARE_PROFILES, TimerReadout } from "../services/esp_flasher";
import { BootLog, LiveSample, ScanResult, TimerConsole, TimerStatus } from "../services/timer_console";

const RACEBAND = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const DBM_MIN = -100;
const DBM_MAX = -30;
const LOG_LINES = 400;
const UNPROVISIONED_FP = "00000001";
const BAD_RESETS = ["panic", "interrupt-watchdog", "task-watchdog", "watchdog", "brownout"];
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

type CheckResult = "pass" | "warn" | "fail" | "skip";

interface Check {
  name: string;
  result: CheckResult;
  detail: string;
}

interface RestartRun {
  n: number;
  ok: boolean;
  ms: number;
  reset: string;
  extraBoots: number;
  note: string;
}

interface DebugTimerInfo {
  found: boolean;
  puckId?: number;
  label?: string;
  online: boolean;
  msSinceSeen?: number;
  framesRx: number;
  simulatorActive: boolean;
}

/**
 * Debug page: connect a timer over USB (WebSerial) and see what it sees. A one-click self-test,
 * status, live 5.8 GHz readings per channel (with temporary channel and receiver controls), a
 * spectrum scan across 5180-5917 MHz, restart / boot-log capture, and the timer's own log.
 * Firmware side: firmware/components/slaprf_radio/slaprf_diag.c. Spec: docs/DEBUG_PAGE.md.
 */
export class DebugView extends Component {
  private readonly console: TimerConsole;
  private status: TimerStatus | null = null;
  private live: LiveSample | null = null;
  private liveCount = 0;
  private liveOn = false;
  private logOn = false;
  private scan: ScanResult | null = null;
  private scanning = false;
  private logLines: string[] = [];
  private error: string | null = null;
  private showAllPorts = false;
  private statusTimer = 0;
  /** Name of the long-running action in progress (self-test, restart test...), or null. */
  private busy: string | null = null;
  private checks: Check[] = [];
  private checksAt: Date | null = null;
  private reportExtra = "";
  private runs: RestartRun[] = [];
  private bootLog: BootLog | null = null;
  private progress = "";
  private channelsDirty = false;

  constructor(el: HTMLElement) {
    super(el);
    this.console = new TimerConsole({
      onStatus: (s) => {
        const freqsChanged = this.status?.freqs.join() !== s.freqs.join();
        this.status = s;
        this.renderConnection();
        this.renderStatus();
        this.renderLiveHead();
        if (freqsChanged) {
          this.renderLive();
          if (!this.channelsDirty) this.renderChannels();
        }
      },
      onLive: (s) => {
        this.live = s;
        this.liveCount++;
        this.updateLive();
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
            <p>Plug a timer into this computer over USB-C. Works with the firmware already on the board; nothing is flashed or saved.</p>
          </div>
          <div class="card" data-slot="connection"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Self-test</h2>
            <p>Checks the timer end to end in about 10 seconds: console, identity, 5.8 GHz receiver, sweep timing, memory, last restart, Wi-Fi, and whether its data reaches this laptop. Copy the report when asking for help.</p>
          </div>
          <div class="card" data-slot="selftest"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Status</h2>
            <p>Identity, chip, uptime, why it last restarted, memory, sweep timing, Wi-Fi and the 5.8 GHz receiver's boot check. Refreshes every 2 seconds.</p>
          </div>
          <div class="card" data-slot="status"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Live 5.8 GHz readings</h2>
            <p>What the timer measures on each of its 8 pilot channels, about 10 times a second. The tick marks the peak since the previous update; hits count sweeps more than 6 dB above that channel's noise floor. Power on a VTX to see its channel rise.</p>
            <p>Try other channels without reflashing, or switch the receiver off to tell whether a problem comes from the 5.8 GHz side. Both reset when the timer restarts.</p>
          </div>
          <div class="card">
            <div data-slot="live-head"></div>
            <div data-slot="live"></div>
            <div data-slot="channels"></div>
          </div>
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
            <h2>Restarts &amp; boot logs</h2>
            <p>The timer keeps its log in memory that survives a crash or restart, so you can read what happened during this boot and the one before it. The restart test checks that the timer comes back cleanly every time.</p>
          </div>
          <div class="card" data-slot="restart"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Live log</h2>
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
    this.listen(el, "input", (e) => {
      if ((e.target as HTMLElement).matches("[data-chan]")) this.channelsDirty = true;
    });
    this.onDispose(() => {
      window.clearInterval(this.statusTimer);
      void this.console.disconnect();
    });
    this.renderAll();
  }

  // ---------------------------------------------------------------- actions

  private async onClick(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    this.error = null;
    try {
      switch (t.dataset.action) {
        case "connect":
          await this.console.connect(this.showAllPorts);
          this.renderAll();
          await this.startSession();
          break;
        case "disconnect":
          if (this.liveOn) await this.console.send("LIVE 0").catch(() => undefined);
          if (this.logOn) await this.console.send("LOG 0").catch(() => undefined);
          await this.console.disconnect();
          break;
        case "live":
          this.liveOn = !this.liveOn;
          await this.console.send(this.liveOn ? "LIVE 1" : "LIVE 0");
          this.renderLiveHead();
          break;
        case "rf": {
          const on = !(this.status?.rf.enabled ?? true);
          if (!on && !confirm("Switch the 5.8 GHz receiver off? The timer stops timing until you switch it back on or restart it.")) break;
          await this.console.request(`RF ${on ? 1 : 0}`, "ok", 2000);
          await this.refreshStatus();
          break;
        }
        case "channels-apply": {
          const freqs = [...this.el.querySelectorAll<HTMLInputElement>("[data-chan]")].map((i) => Math.round(Number(i.value)));
          if (freqs.length !== 8 || freqs.some((f) => !(f >= 5180 && f <= 5917))) {
            throw new Error("Each channel must be between 5180 and 5917 MHz.");
          }
          await this.console.request(`CHANNELS ${freqs.join(",")}`, "ok", 2000);
          this.channelsDirty = false;
          await this.refreshStatus();
          this.renderChannels();
          break;
        }
        case "channels-raceband":
          this.el.querySelectorAll<HTMLInputElement>("[data-chan]").forEach((i, n) => (i.value = String(RACEBAND[n])));
          this.channelsDirty = true;
          break;
        case "channels-reset":
          await this.console.request("CHANNELS RESET", "ok", 2000);
          this.channelsDirty = false;
          await this.refreshStatus();
          this.renderChannels();
          break;
        case "scan": {
          const start = this.num("[data-scan-start]", 5180);
          const stop = this.num("[data-scan-stop]", 5917);
          const step = this.num("[data-scan-step]", 5);
          this.scanning = true;
          this.renderScan();
          await this.console.request(`SCAN ${start} ${stop} ${step}`, "scan", 5000).catch((err: Error) => {
            this.scanning = false;
            this.renderScan();
            throw err;
          });
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
        case "selftest":
          await this.runBusy("Self-test", () => this.runSelfTest());
          break;
        case "copy-report":
          await this.copy(this.reportText(), t);
          break;
        case "restart-capture":
          await this.runBusy("Restarting", () => this.restartAndCapture());
          break;
        case "restart-test": {
          const n = Math.max(1, Math.min(50, this.num("[data-restart-count]", 5)));
          await this.runBusy("Restart test", () => this.restartTest(n));
          break;
        }
        case "bootlog":
          this.bootLog = await this.console.request<BootLog>("BOOTLOG?", "bootlog", 3000);
          this.renderRestart();
          break;
        case "lastlog":
          this.bootLog = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000);
          this.renderRestart();
          break;
        case "copy-bootlog":
          if (this.bootLog) await this.copy(this.bootLogHeader(this.bootLog) + "\n" + this.bootLog.text, t);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|cancel/i.test(msg)) this.error = msg;
    }
    this.renderConnection();
  }

  /** Start polling status and streaming live readings on a freshly opened port. */
  private async startSession(): Promise<void> {
    window.clearInterval(this.statusTimer);
    await this.console.send("STATUS?");
    this.statusTimer = window.setInterval(() => void this.console.send("STATUS?").catch(() => undefined), 2000);
    this.liveOn = true;
    await this.console.send("LIVE 1");
    if (this.logOn) await this.console.send("LOG 1");
    this.renderLiveHead();
  }

  private async refreshStatus(): Promise<TimerStatus> {
    return this.console.request<TimerStatus>("STATUS?", "status", 2000);
  }

  private async runBusy(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = name;
    this.progress = "";
    this.renderBusy();
    try {
      await fn();
    } finally {
      this.busy = null;
      this.progress = "";
      this.renderBusy();
    }
  }

  private setProgress(text: string): void {
    this.progress = text;
    this.renderSelfTest();
    this.renderRestart();
  }

  private async copy(text: string, button: HTMLElement): Promise<void> {
    await navigator.clipboard.writeText(text);
    const label = button.querySelector("span");
    if (label) {
      const old = label.textContent;
      label.textContent = "Copied";
      window.setTimeout(() => (label.textContent = old), 1500);
    }
  }

  // ---------------------------------------------------------------- restarts

  /** Restart, reattach, re-enable the streams the user had on. Returns the first status. */
  private async restart(): Promise<TimerStatus> {
    window.clearInterval(this.statusTimer);
    this.live = null;
    try {
      const s = await this.console.restartAndReconnect();
      this.renderConnection();
      await this.startSession();
      return s;
    } catch (err) {
      await this.console.disconnect();
      throw err;
    }
  }

  private async restartAndCapture(): Promise<void> {
    this.setProgress("Restarting the timer…");
    await this.restart();
    this.setProgress("Reading the boot log…");
    await sleep(1500); // let Wi-Fi and the sweep task finish starting so their messages are in the log
    this.bootLog = await this.console.request<BootLog>("BOOTLOG?", "bootlog", 3000);
    this.renderRestart();
  }

  private async restartTest(count: number): Promise<void> {
    this.runs = [];
    let prev = await this.refreshStatus();
    for (let n = 1; n <= count; n++) {
      this.setProgress(`Restart ${n} of ${count}…`);
      const t0 = performance.now();
      let run: RestartRun;
      try {
        const s = await this.restart();
        const extra = Math.max(0, s.boots - prev.boots - 1);
        const bad = BAD_RESETS.includes(s.reset);
        run = {
          n,
          ok: !bad,
          ms: Math.round(performance.now() - t0),
          reset: s.reset,
          extraBoots: extra,
          note: bad ? "crashed while starting" : extra ? `restarted ${extra} extra time${extra > 1 ? "s" : ""} while starting` : "",
        };
        prev = s;
      } catch (err) {
        this.runs.push({ n, ok: false, ms: Math.round(performance.now() - t0), reset: "—", extraBoots: 0, note: err instanceof Error ? err.message : String(err) });
        this.renderRestart();
        return;
      }
      this.runs.push(run);
      this.renderRestart();
      if (run.extraBoots || !run.ok) {
        // Grab the crashed boot's log while it is still the "previous" one.
        this.bootLog = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000).catch(() => this.bootLog);
      }
      await sleep(1000);
    }
  }

  // ---------------------------------------------------------------- self-test

  private async runSelfTest(): Promise<void> {
    this.checks = [];
    this.reportExtra = "";
    this.checksAt = new Date();
    const add = (name: string, result: CheckResult, detail: string) => {
      this.checks.push({ name, result, detail });
      this.renderSelfTest();
    };

    // 1. Console
    this.setProgress("Asking for status…");
    let s: TimerStatus;
    try {
      s = await this.console.request<TimerStatus>("STATUS?", "status", 3000);
      add("Console", "pass", `firmware ${s.fw}, up ${fmtUptime(s.uptimeMs)}`);
    } catch (err) {
      add("Console", "fail", `${err instanceof Error ? err.message : err}. Is this a SlapRF timer, and is it running (not in download mode)?`);
      return;
    }

    // 2. Identity
    const profile = FIRMWARE_PROFILES.find((p) => p.code === s.profile);
    if (!profile) add("Identity", "fail", `unknown firmware profile ${s.profile}; flash a current SlapRF build`);
    else if (s.fp.toUpperCase() === UNPROVISIONED_FP)
      add("Identity", "warn", `${profile.name}, but not set up yet (default fingerprint). Use Setup → Timers to give it an identity.`);
    else add("Identity", "pass", `${s.label || "(unnamed)"} · ${s.role === 1 ? "Hub" : "Spoke"} · ${profile.name} · ${s.fp}`);

    // 3. Receiver
    if (!s.rf.ok) add("5.8 GHz receiver", "fail", "the receiver's boot check failed; restart the timer and look at the boot log");
    else if (!s.rf.enabled) add("5.8 GHz receiver", "warn", "switched off from this page; switch it back on in Live readings");
    else if (s.rf.floorDb < -100 || s.rf.floorDb > -80)
      add("5.8 GHz receiver", "warn", `noise floor ${s.rf.floorDb.toFixed(1)} dBm is outside the usual −100…−80 dBm (antenna, or strong interference nearby)`);
    else add("5.8 GHz receiver", "pass", `noise floor ${s.rf.floorDb.toFixed(1)} dBm, gain ${s.rf.gain}/${s.rf.gainMax}`);

    // 4. Sweep timing
    const budget = s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0);
    if (!s.sweeps) add("Sweep timing", "fail", "no sweeps yet; the sweep task is not running");
    else if (budget && s.sweepUsMax > budget)
      add("Sweep timing", "warn", `slowest sweep ${(s.sweepUsMax / 1000).toFixed(2)} ms is over the ${(budget / 1000).toFixed(1)} ms budget (typical ${(s.sweepUs / 1000).toFixed(2)} ms)`);
    else add("Sweep timing", "pass", `${s.sweepHz} Hz, ${(s.sweepUs / 1000).toFixed(2)} ms typical, ${(s.sweepUsMax / 1000).toFixed(2)} ms slowest of ${(budget / 1000).toFixed(1)} ms`);

    // 5. Live stream
    this.setProgress("Measuring the live stream…");
    const wasLive = this.liveOn;
    if (!wasLive) await this.console.send("LIVE 1");
    await sleep(300);
    const c0 = this.liveCount;
    await sleep(2000);
    const rate = (this.liveCount - c0) / 2;
    if (!wasLive) await this.console.send("LIVE 0");
    add("Live readings", rate >= 6 ? "pass" : rate > 0 ? "warn" : "fail", `${rate.toFixed(1)} updates/s (expected about 10)`);

    // 6. Spectrum scan
    this.setProgress("Scanning the band…");
    if (!s.rf.enabled) add("Spectrum scan", "skip", "receiver is switched off");
    else {
      const t0 = performance.now();
      try {
        const scan = await this.console.request<ScanResult>("SCAN 5180 5917 5", "scan", 4000);
        const ms = Math.round(performance.now() - t0);
        const expected = Math.floor((5917 - 5180) / 5) + 1;
        add("Spectrum scan", scan.dbm.length === expected && ms < 3000 ? "pass" : "warn", `${scan.dbm.length}/${expected} points in ${(ms / 1000).toFixed(1)} s`);
      } catch (err) {
        add("Spectrum scan", "fail", err instanceof Error ? err.message : String(err));
      }
    }

    // 7. Saved configuration
    this.setProgress("Reading the saved configuration…");
    try {
      const c = await this.console.request<TimerReadout>("SLAPRF?", "config", 2000);
      if (c.fingerprint.toUpperCase() !== s.fp.toUpperCase())
        add("Saved configuration", "fail", `saved fingerprint ${c.fingerprint} doesn't match the running one ${s.fp}`);
      else add("Saved configuration", "pass", `${c.role} "${c.timerLabel}", ${c.frequenciesMHz.length} channels, Wi-Fi "${c.wifiSSID}"`);
    } catch (err) {
      add("Saved configuration", "fail", `couldn't read it (${err instanceof Error ? err.message : err})`);
    }

    // 8. Memory
    add(
      "Memory",
      s.heapMin > 20 * 1024 ? "pass" : "warn",
      `${(s.heapFree / 1024).toFixed(0)} KB free, lowest ${(s.heapMin / 1024).toFixed(0)} KB${s.heapMin > 20 * 1024 ? "" : " (low: it may run out)"}`
    );

    // 9. Last restart
    if (BAD_RESETS.includes(s.reset)) {
      add("Last restart", "fail", `${s.reset}: the timer crashed or lost power. The previous boot's log is attached to the report.`);
      try {
        const last = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000);
        this.bootLog = last;
        this.reportExtra = `\n--- previous boot log (${last.reset}) ---\n${last.text}`;
        this.renderRestart();
      } catch {
        // report without it
      }
    } else add("Last restart", "pass", `${s.reset}, boot #${s.boots}`);

    // 10. Wi-Fi role
    if (s.role === 1) {
      const ap = s.net.mode === "ap" || s.net.mode === "ap+sta";
      add("Wi-Fi", ap ? "pass" : "fail", ap ? `Hub network up on channel ${s.channel}, ${s.net.stations} device${s.net.stations === 1 ? "" : "s"} joined` : `Hub network is not running (mode ${s.net.mode})`);
    } else {
      add("Wi-Fi", s.slot >= 2 ? "pass" : "warn", s.slot >= 2 ? `joined the Hub, slot ${s.slot}, channel ${s.channel}` : "not joined to a Hub yet (is the Hub on and in range?)");
    }

    // 11. Data reaching this laptop
    this.setProgress("Checking that its data reaches this laptop…");
    add(...(await this.checkNetworkPath(s)));
  }

  private async checkNetworkPath(s: TimerStatus): Promise<[string, CheckResult, string]> {
    const name = "Reaches this laptop";
    const get = async (): Promise<DebugTimerInfo | null> => {
      try {
        const res = await fetch(`/api/debug/timer?fp=${encodeURIComponent(s.fp)}`, { cache: "no-store" });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
        return (await res.json()) as DebugTimerInfo;
      } catch {
        return null;
      }
    };
    const a = await get();
    if (!a) return [name, "skip", "no SlapRF server here (open this page from slaprf on the race laptop to check)"];
    if (!a.found) {
      const hint = s.role === 1 ? "Is this laptop joined to the timer's Wi-Fi network?" : "Is the Hub on, and this laptop joined to its Wi-Fi network?";
      return [name, "fail", `the server hasn't heard from ${s.fp}. ${hint}`];
    }
    const sim = a.simulatorActive ? " (the app is showing the simulator; switch to real timers to use it)" : "";
    if (!a.online || (a.msSinceSeen ?? 0) > 3000)
      return [name, "fail", `last heard ${((a.msSinceSeen ?? 0) / 1000).toFixed(0)} s ago${sim}`];
    await sleep(2000);
    const b = await get();
    const perSec = b ? (b.framesRx - a.framesRx) / 2 : 0;
    if (b && b.framesRx > a.framesRx) return [name, a.simulatorActive ? "warn" : "pass", `online as timer ${a.puckId}, ${perSec.toFixed(0)} frames/s${sim}`];
    if (!a.framesRx) return [name, a.simulatorActive ? "warn" : "pass", `online as timer ${a.puckId} (not assigned to a gate, so frames aren't counted)${sim}`];
    return [name, "fail", `online but no new frames in 2 s${sim}`];
  }

  private reportText(): string {
    const s = this.status;
    const lines = [
      `SlapRF self-test · ${this.checksAt?.toISOString() ?? ""}`,
      s ? `${s.label || "(unnamed)"} · ${s.role === 1 ? "Hub" : "Spoke"} · fp ${s.fp} · fw ${s.fw} · profile ${s.profile}` : "",
      s ? `${s.chip.model} ${s.chip.rev} · ${s.chip.mac} · ${s.chip.flashMB} MB flash · boot #${s.boots} (${s.reset})` : "",
      "",
      ...this.checks.map((c) => `[${c.result.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`),
    ];
    return lines.join("\n") + this.reportExtra + "\n";
  }

  // ---------------------------------------------------------------- rendering

  private num(sel: string, fallback: number): number {
    const v = Number(this.el.querySelector<HTMLInputElement>(sel)?.value);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  }

  private renderAll(): void {
    this.renderConnection();
    this.renderSelfTest();
    this.renderStatus();
    this.renderLiveHead();
    this.renderLive();
    this.renderChannels();
    this.renderScan();
    this.renderRestart();
    this.renderLog();
  }

  private renderBusy(): void {
    this.renderConnection();
    this.renderSelfTest();
    this.renderRestart();
  }

  private renderConnection(): void {
    const on = this.console.connected;
    const supported = TimerConsole.supported();
    const busy = this.busy !== null;
    this.slot("connection").innerHTML = `
      <div class="debug-connect">
        <div class="debug-connect-state">
          <span class="status-dot ${on ? "is-up" : ""}"></span>
          <strong>${busy && !on ? `${esc(this.busy!)}…` : on ? (this.status ? `Connected to ${esc(this.status.label || "timer")}` : "Connected") : "Not connected"}</strong>
          ${on && this.status ? `<span class="note mono">${esc(this.status.fp)}</span>` : ""}
        </div>
        <div class="debug-connect-actions">
          ${
            on
              ? `<button type="button" class="btn btn-sm btn-ghost" data-action="read-config" ${busy ? "disabled" : ""}>Read config</button>
                 <button type="button" class="btn btn-sm" data-action="disconnect" ${busy ? "disabled" : ""}>Disconnect</button>`
              : busy
                ? ""
                : `<label class="flasher-port-toggle"><input type="checkbox" data-all-ports ${this.showAllPorts ? "checked" : ""}/><span>Show all USB serial ports</span></label>
                 <button type="button" class="btn btn-armed" data-action="connect" ${supported ? "" : "disabled"}>${icons.plug(15)}<span>Connect over USB</span></button>`
          }
        </div>
      </div>
      ${!supported ? `<p class="note">USB debugging needs Chrome, Edge or Brave (WebSerial).</p>` : ""}
      ${this.error ? `<div class="sim-error-note">${esc(this.error)}</div>` : ""}`;
  }

  private renderSelfTest(): void {
    const on = this.console.connected;
    const running = this.busy === "Self-test";
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of this.checks) counts[c.result]++;
    const summary = this.checks.length
      ? running
        ? esc(this.progress)
        : counts.fail
          ? `<span class="tone-bad">${counts.fail} problem${counts.fail > 1 ? "s" : ""} found</span>`
          : counts.warn
            ? `<span class="debug-tone-warn">Passed with ${counts.warn} warning${counts.warn > 1 ? "s" : ""}</span>`
            : `<span class="tone-good">All checks passed</span>`
      : running
        ? esc(this.progress)
        : on
          ? "Takes about 10 seconds. Timing pauses briefly during the scan."
          : "Connect a timer first.";
    this.slot("selftest").innerHTML = `
      <div class="debug-card-head">
        <span class="note">${summary}</span>
        <div class="debug-connect-actions">
          ${this.checks.length && !running ? `<button type="button" class="btn btn-sm btn-ghost" data-action="copy-report"><span>Copy report</span></button>` : ""}
          <button type="button" class="btn btn-sm btn-armed" data-action="selftest" ${on && !this.busy ? "" : "disabled"}>
            ${icons.bug(14)}<span>${running ? "Testing…" : "Run self-test"}</span>
          </button>
        </div>
      </div>
      ${
        this.checks.length
          ? `<ul class="debug-checks">${this.checks
              .map(
                (c) => `<li class="debug-check is-${c.result}">
                  <span class="debug-check-badge">${c.result === "pass" ? "PASS" : c.result === "warn" ? "WARN" : c.result === "fail" ? "FAIL" : "SKIP"}</span>
                  <strong>${esc(c.name)}</strong>
                  <span class="debug-check-detail">${esc(c.detail)}</span>
                </li>`
              )
              .join("")}</ul>`
          : ""
      }`;
  }

  private renderStatus(): void {
    const s = this.status;
    if (!s) {
      this.slot("status").innerHTML = `<p class="note">${this.console.connected ? "Waiting for the timer…" : "Connect a timer to see its status."}</p>`;
      return;
    }
    const profile = FIRMWARE_PROFILES.find((p) => p.code === s.profile);
    const budget = s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0);
    const badReset = BAD_RESETS.includes(s.reset);
    const rows: Array<[string, string]> = [
      ["Timer", `${esc(s.label || "(unnamed)")} · ${s.role === 1 ? "Hub" : "Spoke"}${s.slot ? ` · slot ${s.slot}` : ""}`],
      ["Firmware", `${esc(profile?.name ?? `profile ${s.profile}`)} · ${esc(s.fw)}`],
      ["Fingerprint", `<span class="mono">${esc(s.fp)}</span>${s.fp.toUpperCase() === UNPROVISIONED_FP ? ` <span class="badge debug-tone-warn">not set up</span>` : ""}`],
      ["Chip", s.chip ? `${esc(s.chip.model)} ${esc(s.chip.rev)} · ${s.chip.flashMB} MB flash · <span class="mono">${esc(s.chip.mac)}</span>` : "—"],
      ["Uptime", `${fmtUptime(s.uptimeMs)} <span class="note">(boot #${s.boots ?? "?"})</span>`],
      ["Last restart", badReset ? `<span class="tone-bad">${esc(s.reset)}</span> <span class="note">— see the previous boot's log below</span>` : esc(s.reset)],
      ["Memory free", `${(s.heapFree / 1024).toFixed(0)} KB <span class="note">(lowest ${(s.heapMin / 1024).toFixed(0)} KB)</span>`],
      [
        "Sweeps",
        `${s.sweepHz} Hz · ${(s.sweepUs / 1000).toFixed(2)} ms <span class="note">(slowest <span class="${budget && s.sweepUsMax > budget ? "debug-tone-warn" : ""}">${(s.sweepUsMax / 1000).toFixed(2)} ms</span> of ${(budget / 1000).toFixed(1)} ms)</span>`,
      ],
      [
        "5.8 GHz receiver",
        !s.rf.ok
          ? `<span class="badge tone-bad">Boot check failed</span>`
          : !s.rf.enabled
            ? `<span class="badge debug-tone-warn">Switched off</span>`
            : `<span class="badge tone-good">OK</span> gain ${s.rf.gain}/${s.rf.gainMax} · floor ${s.rf.floorDb.toFixed(1)} dBm`,
      ],
      [
        "Wi-Fi",
        s.net
          ? s.role === 1
            ? `${esc(s.net.mode)} · channel ${s.channel} · ${s.net.stations} device${s.net.stations === 1 ? "" : "s"} joined`
            : `${esc(s.net.mode)} · channel ${s.channel}${s.slot >= 2 ? ` · slot ${s.slot}` : " · not joined to a Hub"}`
          : `channel ${s.channel}`,
      ],
      ["Channels", `<span class="mono">${s.freqs.join(" · ")}</span> MHz${s.freqsTemporary ? ` <span class="badge debug-tone-warn">temporary</span>` : ""}`],
    ];
    this.slot("status").innerHTML = `
      <dl class="debug-status">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      </dl>`;
  }

  private renderLiveHead(): void {
    const on = this.console.connected;
    const rfOn = this.status?.rf.enabled ?? true;
    this.slot("live-head").innerHTML = `
      <div class="debug-card-head">
        <span class="note" data-live-note>${on ? "" : "Not connected"}</span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm ${rfOn ? "btn-ghost" : "btn-danger-active"}" data-action="rf" ${on && this.status ? "" : "disabled"}>
            ${rfOn ? icons.signal(14) : icons.signalOff(14)}<span>${rfOn ? "Receiver on" : "Receiver off"}</span>
          </button>
          <button type="button" class="btn btn-sm ${this.liveOn ? "btn-armed" : "btn-ghost"}" data-action="live" ${on ? "" : "disabled"}>
            ${this.liveOn ? icons.pause(14) : icons.play(14)}<span>${this.liveOn ? "Pause" : "Resume"}</span>
          </button>
        </div>
      </div>`;
    this.updateLive();
  }

  /** Build the bar rows once per channel set; updateLive() then only touches styles and text. */
  private renderLive(): void {
    const freqs = this.status?.freqs ?? RACEBAND;
    this.slot("live").innerHTML = `
      <div class="debug-bars">
        ${freqs
          .map((f) => {
            const band = racebandName(f);
            return `
            <div class="debug-bar-row" data-bar>
              <span class="debug-bar-label mono">${band ? `<strong>${band}</strong> ` : ""}${f}</span>
              <div class="debug-bar-track">
                <span class="debug-bar-fill" style="width:0%"></span>
                <span class="debug-bar-peak" style="left:0%;display:none"></span>
              </div>
              <span class="debug-bar-value mono">—</span>
              <span class="debug-bar-hits mono" title="Sweeps more than 6 dB above the noise floor since the previous update">—</span>
            </div>`;
          })
          .join("")}
      </div>
      <div class="debug-scale mono"><span>${DBM_MIN} dBm</span><span>${DBM_MAX} dBm</span></div>`;
    this.updateLive();
  }

  private updateLive(): void {
    const l = this.live;
    const note = this.el.querySelector<HTMLElement>("[data-live-note]");
    if (note && this.console.connected) {
      note.textContent = this.status && !this.status.rf.enabled ? "Receiver off" : l ? `sweep ${(l.us / 1000).toFixed(2)} ms` : "";
    }
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    this.el.querySelectorAll<HTMLElement>("[data-bar]").forEach((row, i) => {
      const fill = row.querySelector<HTMLElement>(".debug-bar-fill")!;
      const peak = row.querySelector<HTMLElement>(".debug-bar-peak")!;
      const value = row.querySelector<HTMLElement>(".debug-bar-value")!;
      const hits = row.querySelector<HTMLElement>(".debug-bar-hits")!;
      const v = l?.dbm[i];
      const pk = l?.pk[i];
      const h = l?.hits?.[i];
      fill.style.width = v !== undefined && v > -127 ? `${pct(v)}%` : "0%";
      peak.style.display = pk !== undefined && pk > -127 ? "" : "none";
      if (pk !== undefined) peak.style.left = `${pct(pk)}%`;
      value.textContent = v !== undefined && v > -127 ? `${v} dBm` : "—";
      hits.textContent = h !== undefined ? `${h} hit${h === 1 ? "" : "s"}` : "";
      hits.classList.toggle("is-active", (h ?? 0) > 0);
    });
  }

  private renderChannels(): void {
    const on = this.console.connected;
    const s = this.status;
    const freqs = s?.freqs ?? RACEBAND;
    this.slot("channels").innerHTML = `
      <div class="debug-channels">
        <div class="debug-channels-head">
          <strong>Try other channels</strong>
          ${s?.freqsTemporary ? `<span class="badge debug-tone-warn">temporary: not saved</span>` : `<span class="note">Saved channels in use</span>`}
        </div>
        <div class="debug-channels-inputs">
          ${freqs
            .map((f, i) => `<label><span class="note">${i + 1}</span><input class="input mono" type="number" min="5180" max="5917" data-chan value="${f}" ${on ? "" : "disabled"}/></label>`)
            .join("")}
        </div>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="channels-raceband" ${on ? "" : "disabled"}>Raceband</button>
          ${s?.freqsTemporary ? `<button type="button" class="btn btn-sm btn-ghost" data-action="channels-reset" ${on ? "" : "disabled"}>Back to saved</button>` : ""}
          <button type="button" class="btn btn-sm btn-armed" data-action="channels-apply" ${on && s ? "" : "disabled"}>Apply until restart</button>
        </div>
      </div>`;
  }

  private renderScan(): void {
    const on = this.console.connected;
    const s = this.scan;
    const prev = {
      start: this.el.querySelector<HTMLInputElement>("[data-scan-start]")?.value ?? "5180",
      stop: this.el.querySelector<HTMLInputElement>("[data-scan-stop]")?.value ?? "5917",
      step: this.el.querySelector<HTMLInputElement>("[data-scan-step]")?.value ?? "5",
    };
    this.slot("scan").innerHTML = `
      <div class="debug-card-head">
        <div class="debug-scan-inputs">
          <label>From <input class="input mono" type="number" data-scan-start value="${esc(prev.start)}" min="5180" max="5917"/></label>
          <label>to <input class="input mono" type="number" data-scan-stop value="${esc(prev.stop)}" min="5180" max="5917"/></label>
          <label>step <input class="input mono" type="number" data-scan-step value="${esc(prev.step)}" min="1" max="50"/></label>
          <span class="note">MHz</span>
        </div>
        <button type="button" class="btn btn-sm btn-armed" data-action="scan" ${on && !this.scanning ? "" : "disabled"}>
          ${icons.signal(14)}<span>${this.scanning ? "Scanning…" : "Scan"}</span>
        </button>
      </div>
      ${s ? spectrumSvg(s) : `<p class="note">${on ? "Run a scan to see the band." : "Connect a timer to scan."}</p>`}`;
  }

  private bootLogHeader(l: BootLog): string {
    return `${l.which === "last" ? "Previous boot" : "This boot"} · boot #${l.boots} · restart reason: ${l.reset}`;
  }

  private renderRestart(): void {
    const on = this.console.connected;
    const busy = this.busy !== null;
    const restartBusy = this.busy === "Restarting" || this.busy === "Restart test";
    const l = this.bootLog;
    this.slot("restart").innerHTML = `
      <div class="debug-card-head">
        <span class="note">${restartBusy ? esc(this.progress) : on ? "The USB connection drops during a restart; the page reconnects by itself." : "Connect a timer first."}</span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="bootlog" ${on && !busy ? "" : "disabled"}>This boot's log</button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="lastlog" ${on && !busy ? "" : "disabled"}>Previous boot's log</button>
          <button type="button" class="btn btn-sm btn-armed" data-action="restart-capture" ${on && !busy ? "" : "disabled"}>${icons.reset(14)}<span>Restart &amp; capture boot log</span></button>
        </div>
      </div>
      <div class="debug-restart-test">
        <label>Restart test <input class="input mono" type="number" data-restart-count value="${esc(this.el.querySelector<HTMLInputElement>("[data-restart-count]")?.value ?? "5")}" min="1" max="50"/> times</label>
        <button type="button" class="btn btn-sm btn-ghost" data-action="restart-test" ${on && !busy ? "" : "disabled"}>${icons.reset(14)}<span>${this.busy === "Restart test" ? "Running…" : "Run"}</span></button>
      </div>
      ${
        this.runs.length
          ? `<table class="debug-runs">
              <thead><tr><th>#</th><th>Result</th><th>Back in</th><th>Restart reason</th><th></th></tr></thead>
              <tbody>${this.runs
                .map(
                  (r) => `<tr>
                    <td class="mono">${r.n}</td>
                    <td><span class="badge ${r.ok && !r.extraBoots ? "tone-good" : r.ok ? "debug-tone-warn" : "tone-bad"}">${r.ok && !r.extraBoots ? "OK" : r.ok ? "WARN" : "FAIL"}</span></td>
                    <td class="mono">${(r.ms / 1000).toFixed(1)} s</td>
                    <td>${esc(r.reset)}</td>
                    <td class="note">${esc(r.note)}</td>
                  </tr>`
                )
                .join("")}</tbody>
            </table>`
          : ""
      }
      ${
        l
          ? `<div class="debug-bootlog">
              <div class="debug-card-head">
                <strong>${esc(this.bootLogHeader(l))}</strong>
                <button type="button" class="btn btn-sm btn-ghost" data-action="copy-bootlog"><span>Copy log</span></button>
              </div>
              <pre class="debug-log mono">${esc(l.text || "(empty)")}</pre>
            </div>`
          : ""
      }`;
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
    const count = this.el.querySelector<HTMLElement>("[data-log-count]");
    if (count) count.textContent = `${this.logLines.length} lines`;
  }

  private renderLog(): void {
    const on = this.console.connected;
    this.slot("log").innerHTML = `
      <div class="debug-card-head debug-log-head">
        <span class="note" data-log-count>${this.logLines.length} lines</span>
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
        .map((f) => `<line class="band" x1="${x(f)}" x2="${x(f)}" y1="${T}" y2="${H - B}"/><text class="band-label" x="${x(f)}" y="${T + 10}" text-anchor="middle">R${RACEBAND.indexOf(f) + 1}</text>`)
        .join("")}
      <polyline class="trace" points="${pts}"/>
      <circle class="peak" cx="${x(s.start + peak * s.step)}" cy="${y(s.dbm[peak])}" r="3.5"/>
      <text class="peak-label" x="${Math.min(W - R - 4, x(s.start + peak * s.step) + 6)}" y="${Math.max(T + 22, y(s.dbm[peak]) - 6)}">${s.start + peak * s.step} MHz · ${s.dbm[peak]} dBm</text>
    </svg>`;
}
