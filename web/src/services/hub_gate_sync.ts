import { AppStore } from "../state/store";
import { DetectedTimer, TrackNode } from "../types/models";
import { ApiClient } from "./api_client";
import { sharedTimerConsole, TimerStatus } from "./timer_console";

/**
 * Keeps the physical Hub's sweep mode in sync with the course.
 *
 * The Hub is a USB collector dongle. If the user drags it onto a gate (the real engine then has a
 * gate whose `assignedTimerId` is the Hub's timer), the Hub must also sweep 5.8 GHz and send its
 * own telemetry: `HUBGATE 1`. Dragging it off returns it to a pure dongle: `HUBGATE 0`. The Hub
 * reports its current mode as `hubGate` in its STATUS JSON; the flag is runtime-only (it resets
 * to off when the Hub reboots), so this module re-checks on every Hub status (polled ~1 s) and on
 * every course change, and re-sends the command whenever the two disagree.
 */

/** Minimum gap between two identical commands while the Hub hasn't confirmed the change. */
export const HUB_GATE_RESEND_MS = 1000;
/** After this many unconfirmed attempts (e.g. older firmware without HUBGATE), back off. */
export const HUB_GATE_FAST_ATTEMPTS = 5;
export const HUB_GATE_SLOW_RESEND_MS = 10_000;

export type HubGateCommand = "HUBGATE 1" | "HUBGATE 0";

/** Rate-limit memory for the command last sent towards one desired state. */
export interface HubGateSendState {
  /** The state the last command asked for. */
  state: boolean;
  /** When it was sent (ms, any monotonic clock). */
  atMs: number;
  /** Consecutive unconfirmed attempts for `state`. */
  attempts: number;
}

/**
 * True when the course (real engine) puts the Hub on a gate: some gate is assigned to a detected
 * timer flagged `isHub`.
 */
export function hubShouldSweep(timers: Pick<DetectedTimer, "timerId" | "isHub">[], nodes: Pick<TrackNode, "assignedTimerId">[]): boolean {
  const hubIds = new Set(timers.filter((t) => t.isHub && t.timerId > 0).map((t) => t.timerId));
  if (hubIds.size === 0) return false;
  return nodes.some((n) => hubIds.has(n.assignedTimerId ?? 0));
}

/**
 * Decides whether to send a HUBGATE command. Pure (no I/O) so it can be unit-tested.
 *
 * - Only for a connected Hub (status `role === 1`) in real-hardware mode.
 * - `status.hubGate` missing counts as off.
 * - Never repeats a command for the same state faster than `HUB_GATE_RESEND_MS` (backing off to
 *   `HUB_GATE_SLOW_RESEND_MS` after `HUB_GATE_FAST_ATTEMPTS` unconfirmed tries).
 */
export function decideHubGateCommand(input: {
  realMode: boolean;
  connected: boolean;
  status: Pick<TimerStatus, "role" | "hubGate"> | null;
  desired: boolean;
  nowMs: number;
  last: HubGateSendState | null;
}): HubGateCommand | null {
  const { realMode, connected, status, desired, nowMs, last } = input;
  if (!realMode || !connected || !status || status.role !== 1) return null;
  if ((status.hubGate === true) === desired) return null;
  if (last && last.state === desired) {
    const gap = last.attempts >= HUB_GATE_FAST_ATTEMPTS ? HUB_GATE_SLOW_RESEND_MS : HUB_GATE_RESEND_MS;
    if (nowMs - last.atMs < gap) return null;
  }
  return desired ? "HUBGATE 1" : "HUBGATE 0";
}

/** Folds a sent command into the rate-limit memory. */
export function nextSendState(last: HubGateSendState | null, desired: boolean, nowMs: number): HubGateSendState {
  const attempts = last && last.state === desired ? last.attempts + 1 : 1;
  return { state: desired, atMs: nowMs, attempts };
}

/** Wires `decideHubGateCommand` to the USB console, the store, and the API client. */
export class HubGateSync {
  private last: HubGateSendState | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    private readonly store: AppStore,
    private readonly api: ApiClient
  ) {}

  public start(): void {
    this.unsubs.push(
      sharedTimerConsole.subscribe({
        onStatus: (s) => this.reconcile(s),
        onConnect: () => (this.last = null),
        onDisconnect: () => (this.last = null),
      }),
      this.store.subscribe(["config", "status"], () => this.reconcile(sharedTimerConsole.lastStatus))
    );
  }

  public stop(): void {
    this.unsubs.splice(0).forEach((u) => u());
  }

  /** Desired Hub mode from the real engine's course (as mirrored in the store). */
  public get desired(): boolean {
    return hubShouldSweep(this.store.detectedTimers, this.store.nodes);
  }

  private reconcile(status: TimerStatus | null): void {
    const realMode = this.api.usingBrowserRealEngine && !this.store.simulatorRunning;
    const desired = realMode ? this.desired : false;
    if (status && (status.hubGate === true) === desired) {
      this.last = null; // Confirmed: forget unconfirmed attempts
      return;
    }
    const nowMs = performance.now();
    const cmd = decideHubGateCommand({
      realMode,
      connected: sharedTimerConsole.connected,
      status,
      desired,
      nowMs,
      last: this.last,
    });
    if (!cmd) return;
    this.last = nextSendState(this.last, desired, nowMs);
    void sharedTimerConsole.send(cmd).catch(() => undefined);
  }
}
