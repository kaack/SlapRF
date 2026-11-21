import {
  resetRouterStateForTest,
  setPracticeTopBarContext,
  setRacesTopBarContext,
} from "../core/router";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { closeActiveLapEditorModal } from "../widgets/HeatLapEditorModal";
import { closeActiveMultiGPModal } from "../widgets/MultiGPRaceModals";
import { closeActiveRoundModal } from "../widgets/RoundModals";
import {
  DetectedTimer,
  EventPilot,
  FilteredDetection,
  FullStateResponse,
  GateCrossingEvent,
  HeatLap,
  HeatSeat,
  LapRecord,
  PilotSlot,
  PracticeSession,
  RaceHeat,
  RaceRound,
  RaceSetupConfig,
  RaceStage,
  RaceTournamentState,
  RoundConnection,
  SectorSplit,
  StageConnection,
  TimingRules,
  TrackNode,
} from "../types/models";

// ============================================================================
// Minimal, Fast, Zero-Dependency TypeScript Unit Test Runner
// ============================================================================

type HookFn = () => void | Promise<void>;
type TestFn = () => void | Promise<void>;

interface RegisteredTest {
  name: string;
  fn: TestFn;
  skipped?: boolean;
}

interface SuiteNode {
  name: string;
  beforeEachFns: HookFn[];
  afterEachFns: HookFn[];
  tests: RegisteredTest[];
  children: SuiteNode[];
}

export interface TestCaseResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  durationMs: number;
  error?: string;
}

export interface SuiteReport {
  name: string;
  durationMs: number;
  tests: TestCaseResult[];
}

export interface FullUnitReport {
  totalSuites: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  durationMs: number;
  fatalError?: string;
  suites: SuiteReport[];
}

const rootSuites: SuiteNode[] = [];
const suiteStack: SuiteNode[] = [];
const activeSpies: Array<{ restore: () => void }> = [];

export function describe(name: string, defineFn: () => void): void {
  const node: SuiteNode = {
    name,
    beforeEachFns: [],
    afterEachFns: [],
    tests: [],
    children: [],
  };
  if (suiteStack.length > 0) {
    suiteStack[suiteStack.length - 1].children.push(node);
  } else {
    rootSuites.push(node);
  }
  suiteStack.push(node);
  try {
    defineFn();
  } finally {
    suiteStack.pop();
  }
}

export function it(name: string, fn: TestFn): void {
  if (suiteStack.length === 0) {
    throw new Error(`it("${name}") must be called inside describe(...)`);
  }
  suiteStack[suiteStack.length - 1].tests.push({ name, fn });
}

export const test = it;

it.skip = (name: string, fn: TestFn): void => {
  if (suiteStack.length === 0) {
    throw new Error(`it.skip("${name}") must be called inside describe(...)`);
  }
  suiteStack[suiteStack.length - 1].tests.push({ name, fn, skipped: true });
};

export function beforeEach(fn: HookFn): void {
  if (suiteStack.length === 0) {
    throw new Error("beforeEach() must be called inside describe(...)");
  }
  suiteStack[suiteStack.length - 1].beforeEachFns.push(fn);
}

export function afterEach(fn: HookFn): void {
  if (suiteStack.length === 0) {
    throw new Error("afterEach() must be called inside describe(...)");
  }
  suiteStack[suiteStack.length - 1].afterEachFns.push(fn);
}

// ============================================================================
// Spy / Mock Utilities
// ============================================================================

export interface MockFn<TArgs extends unknown[] = unknown[], TRet = unknown> {
  (...args: TArgs): TRet;
  calls: TArgs[];
  mockReturnValue: (val: TRet) => MockFn<TArgs, TRet>;
  mockImplementation: (impl: (...args: TArgs) => TRet) => MockFn<TArgs, TRet>;
  mockClear: () => void;
  restore: () => void;
}

export function fn<TArgs extends unknown[] = unknown[], TRet = unknown>(
  initialImpl?: (...args: TArgs) => TRet
): MockFn<TArgs, TRet> {
  let impl: ((...args: TArgs) => TRet) | undefined = initialImpl;
  let hasFixedReturn = false;
  let fixedReturn: TRet;

  const callable = function (...args: TArgs): TRet {
    callable.calls.push(args);
    if (impl) return impl(...args);
    if (hasFixedReturn) return fixedReturn;
    return undefined as unknown as TRet;
  } as MockFn<TArgs, TRet>;

  callable.calls = [];
  callable.mockReturnValue = (val: TRet) => {
    impl = undefined;
    hasFixedReturn = true;
    fixedReturn = val;
    return callable;
  };
  callable.mockImplementation = (nextImpl: (...args: TArgs) => TRet) => {
    hasFixedReturn = false;
    impl = nextImpl;
    return callable;
  };
  callable.mockClear = () => {
    callable.calls.length = 0;
  };
  callable.restore = () => {};
  return callable;
}

export function spyOn<T extends object, K extends keyof T>(
  target: T,
  key: K
): MockFn<unknown[], unknown> {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
  const origDesc = Object.getOwnPropertyDescriptor(target, key);
  const original = target[key];
  const origFn =
    typeof original === "function"
      ? (original as (...args: unknown[]) => unknown).bind(target)
      : () => original;

  const mock = fn<unknown[], unknown>(origFn);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (hadOwn && origDesc) {
      Object.defineProperty(target, key, origDesc);
    } else {
      delete (target as Record<PropertyKey, unknown>)[key];
    }
  };
  mock.restore = restore;
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: mock,
  });
  activeSpies.push({ restore });
  return mock;
}

// ============================================================================
// Deep Equality & Rich Assertion Matchers
// ============================================================================

function formatVal(v: unknown): string {
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (v === undefined) return "undefined";
  if (v instanceof Set) return `Set(${JSON.stringify([...v])})`;
  if (v instanceof Map) return `Map(${JSON.stringify([...v.entries()])})`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, val] of a.entries()) {
      if (!b.has(k) || !deepEqual(val, b.get(k))) return false;
    }
    return true;
  }

  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k) && objB[k] !== undefined) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

export interface Matchers<T> {
  readonly not: Matchers<T>;
  readonly rejects: {
    toThrow: (expected?: string | RegExp) => Promise<void>;
  };
  toBe: (expected: T) => void;
  toEqual: (expected: unknown) => void;
  toStrictEqual: (expected: unknown) => void;
  toBeTruthy: () => void;
  toBeFalsy: () => void;
  toBeNull: () => void;
  toBeUndefined: () => void;
  toBeDefined: () => void;
  toBeNaN: () => void;
  toBeCloseTo: (expected: number, precision?: number) => void;
  toBeGreaterThan: (expected: number) => void;
  toBeGreaterThanOrEqual: (expected: number) => void;
  toBeLessThan: (expected: number) => void;
  toBeLessThanOrEqual: (expected: number) => void;
  toContain: (item: unknown) => void;
  toMatch: (pattern: string | RegExp) => void;
  toHaveLength: (expected: number) => void;
  toThrow: (expected?: string | RegExp) => void;
}

function buildMatchers<T>(actual: T, isNot: boolean): Matchers<T> {
  const check = (cond: boolean, posMsg: () => string, negMsg: () => string): void => {
    const ok = isNot ? !cond : cond;
    if (!ok) {
      throw new Error(isNot ? negMsg() : posMsg());
    }
  };

  return {
    get not(): Matchers<T> {
      return buildMatchers(actual, !isNot);
    },
    rejects: {
      toThrow: async (expected?: string | RegExp): Promise<void> => {
        let threw = false;
        let errMsg = "";
        try {
          await (actual as unknown as Promise<unknown>);
        } catch (err) {
          threw = true;
          errMsg = err instanceof Error ? err.message : String(err);
        }
        if (!isNot) {
          if (!threw) {
            throw new Error("Expected promise to reject, but it resolved");
          }
          if (expected !== undefined) {
            const matches =
              typeof expected === "string"
                ? errMsg.includes(expected)
                : expected.test(errMsg);
            if (!matches) {
              throw new Error(
                `Expected rejection message "${errMsg}" to match ${String(expected)}`
              );
            }
          }
        } else if (threw) {
          throw new Error(`Expected promise not to reject, but rejected with "${errMsg}"`);
        }
      },
    },
    toBe(expected: T) {
      check(
        Object.is(actual, expected),
        () => `Expected ${formatVal(actual)} to be ${formatVal(expected)}`,
        () => `Expected ${formatVal(actual)} not to be ${formatVal(expected)}`
      );
    },
    toEqual(expected: unknown) {
      check(
        deepEqual(actual, expected),
        () => `Expected ${formatVal(actual)} to equal ${formatVal(expected)}`,
        () => `Expected ${formatVal(actual)} not to equal ${formatVal(expected)}`
      );
    },
    toStrictEqual(expected: unknown) {
      check(
        deepEqual(actual, expected),
        () => `Expected ${formatVal(actual)} to strictly equal ${formatVal(expected)}`,
        () => `Expected ${formatVal(actual)} not to strictly equal ${formatVal(expected)}`
      );
    },
    toBeTruthy() {
      check(
        Boolean(actual),
        () => `Expected ${formatVal(actual)} to be truthy`,
        () => `Expected ${formatVal(actual)} not to be truthy`
      );
    },
    toBeFalsy() {
      check(
        !actual,
        () => `Expected ${formatVal(actual)} to be falsy`,
        () => `Expected ${formatVal(actual)} not to be falsy`
      );
    },
    toBeNull() {
      check(
        actual === null,
        () => `Expected ${formatVal(actual)} to be null`,
        () => `Expected ${formatVal(actual)} not to be null`
      );
    },
    toBeUndefined() {
      check(
        actual === undefined,
        () => `Expected ${formatVal(actual)} to be undefined`,
        () => `Expected ${formatVal(actual)} not to be undefined`
      );
    },
    toBeDefined() {
      check(
        actual !== undefined,
        () => `Expected value to be defined`,
        () => `Expected ${formatVal(actual)} to be undefined`
      );
    },
    toBeNaN() {
      check(
        typeof actual === "number" && Number.isNaN(actual),
        () => `Expected ${formatVal(actual)} to be NaN`,
        () => `Expected value not to be NaN`
      );
    },
    toBeCloseTo(expected: number, precision = 2) {
      const num = Number(actual);
      const maxDiff = Math.pow(10, -precision) / 2;
      const cond = Number.isFinite(num) && Math.abs(num - expected) < maxDiff;
      check(
        cond,
        () => `Expected ${formatVal(actual)} to be close to ${expected} (precision=${precision})`,
        () => `Expected ${formatVal(actual)} not to be close to ${expected}`
      );
    },
    toBeGreaterThan(expected: number) {
      check(
        Number(actual) > expected,
        () => `Expected ${formatVal(actual)} > ${expected}`,
        () => `Expected ${formatVal(actual)} not > ${expected}`
      );
    },
    toBeGreaterThanOrEqual(expected: number) {
      check(
        Number(actual) >= expected,
        () => `Expected ${formatVal(actual)} >= ${expected}`,
        () => `Expected ${formatVal(actual)} not >= ${expected}`
      );
    },
    toBeLessThan(expected: number) {
      check(
        Number(actual) < expected,
        () => `Expected ${formatVal(actual)} < ${expected}`,
        () => `Expected ${formatVal(actual)} not < ${expected}`
      );
    },
    toBeLessThanOrEqual(expected: number) {
      check(
        Number(actual) <= expected,
        () => `Expected ${formatVal(actual)} <= ${expected}`,
        () => `Expected ${formatVal(actual)} not <= ${expected}`
      );
    },
    toContain(item: unknown) {
      let cond = false;
      if (typeof actual === "string") {
        cond = actual.includes(String(item));
      } else if (Array.isArray(actual)) {
        cond = actual.some((el) => deepEqual(el, item));
      } else if (actual instanceof Set) {
        cond = actual.has(item);
      }
      check(
        cond,
        () => `Expected ${formatVal(actual)} to contain ${formatVal(item)}`,
        () => `Expected ${formatVal(actual)} not to contain ${formatVal(item)}`
      );
    },
    toMatch(pattern: string | RegExp) {
      const str = String(actual);
      const cond = typeof pattern === "string" ? str.includes(pattern) : pattern.test(str);
      check(
        cond,
        () => `Expected "${str}" to match ${String(pattern)}`,
        () => `Expected "${str}" not to match ${String(pattern)}`
      );
    },
    toHaveLength(expected: number) {
      const len = (actual as { length?: number; size?: number } | null)?.length ??
        (actual as { size?: number } | null)?.size ??
        -1;
      check(
        len === expected,
        () => `Expected length ${expected}, got ${len} (${formatVal(actual)})`,
        () => `Expected length not to be ${expected}`
      );
    },
    toThrow(expected?: string | RegExp) {
      if (typeof actual !== "function") {
        throw new Error(`expect(fn).toThrow() requires a function, got ${typeof actual}`);
      }
      let threw = false;
      let errMsg = "";
      try {
        (actual as () => unknown)();
      } catch (err) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      if (!isNot) {
        if (!threw) {
          throw new Error("Expected function to throw, but it returned normally");
        }
        if (expected !== undefined) {
          const matches =
            typeof expected === "string" ? errMsg.includes(expected) : expected.test(errMsg);
          if (!matches) {
            throw new Error(`Expected thrown message "${errMsg}" to match ${String(expected)}`);
          }
        }
      } else if (threw) {
        throw new Error(`Expected function not to throw, but threw "${errMsg}"`);
      }
    },
  };
}

export function expect<T>(actual: T): Matchers<T> {
  return buildMatchers(actual, false);
}

// ============================================================================
// DOM & Environment Isolation Helpers
// ============================================================================

export function getTestRoot(): HTMLElement {
  let root = document.getElementById("test-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "test-root";
    document.body.appendChild(root);
  }
  return root;
}

export function mountHtml(html: string): HTMLElement {
  const root = getTestRoot();
  root.innerHTML = html;
  return root;
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function resetTestEnvironment(): void {
  while (activeSpies.length > 0) {
    activeSpies.pop()?.restore();
  }
  closeActiveRoundModal();
  closeActiveLapEditorModal();
  closeActiveMultiGPModal();
  document
    .querySelectorAll(
      ".slaprf-modal-backdrop, .slaprf-toaster, .custom-select-popover, [data-cselect-popover], [data-wire-drop-menu]"
    )
    .forEach((el) => el.remove());

  const testRoot = document.getElementById("test-root");
  if (testRoot) testRoot.innerHTML = "";
  const appRoot = document.getElementById("app");
  if (appRoot) appRoot.innerHTML = "";

  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Ignore
  }
  try {
    location.hash = "#/";
  } catch {
    // Ignore
  }
  resetRouterStateForTest();
  setRacesTopBarContext({
    tab: "directory",
    raceId: "",
    raceName: "",
    activeStage: 1,
    totalStages: 1,
    stageTitle: "",
  });
  setPracticeTopBarContext({
    tab: "directory",
    sessionId: "",
    sessionName: "",
    active: false,
  });
}

// ============================================================================
// Suite Execution & Reporting
// ============================================================================

async function runSuiteNode(
  node: SuiteNode,
  prefix: string,
  inheritedBefore: HookFn[],
  inheritedAfter: HookFn[],
  filter: string,
  outSuites: SuiteReport[]
): Promise<void> {
  const fullSuiteName = prefix ? `${prefix} > ${node.name}` : node.name;
  const beforeAllChain = [...inheritedBefore, ...node.beforeEachFns];
  const afterAllChain = [...node.afterEachFns, ...inheritedAfter];

  if (node.tests.length > 0) {
    const suiteStart = performance.now();
    const results: TestCaseResult[] = [];

    for (const tc of node.tests) {
      const fullTestName = `${fullSuiteName} :: ${tc.name}`;
      if (filter && !fullTestName.toLowerCase().includes(filter)) {
        continue;
      }
      if (tc.skipped) {
        results.push({
          name: tc.name,
          passed: true,
          skipped: true,
          durationMs: 0,
        });
        continue;
      }

      const t0 = performance.now();
      resetTestEnvironment();
      let passed = true;
      let errStr: string | undefined;

      try {
        for (const b of beforeAllChain) {
          await b();
        }
        await tc.fn();
      } catch (err) {
        passed = false;
        errStr =
          err instanceof Error
            ? `${err.message}${err.stack ? `\n${err.stack}` : ""}`
            : String(err);
      } finally {
        for (const a of afterAllChain) {
          try {
            await a();
          } catch (afterErr) {
            if (passed) {
              passed = false;
              errStr =
                afterErr instanceof Error
                  ? `afterEach failed: ${afterErr.message}`
                  : `afterEach failed: ${String(afterErr)}`;
            }
          }
        }
        resetTestEnvironment();
      }

      results.push({
        name: tc.name,
        passed,
        durationMs: Math.round((performance.now() - t0) * 100) / 100,
        error: errStr,
      });
    }

    if (results.length > 0) {
      outSuites.push({
        name: fullSuiteName,
        durationMs: Math.round((performance.now() - suiteStart) * 100) / 100,
        tests: results,
      });
    }
  }

  for (const child of node.children) {
    await runSuiteNode(child, fullSuiteName, beforeAllChain, afterAllChain, filter, outSuites);
  }
}

export async function runAllRegisteredSuites(): Promise<FullUnitReport> {
  const start = performance.now();
  const params = new URLSearchParams(window.location.search);
  const filter = (params.get("filter") ?? "").trim().toLowerCase();
  const suites: SuiteReport[] = [];

  for (const s of rootSuites) {
    await runSuiteNode(s, "", [], [], filter, suites);
  }

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;

  for (const s of suites) {
    for (const t of s.tests) {
      totalTests++;
      if (t.skipped) {
        skippedTests++;
      } else if (t.passed) {
        passedTests++;
      } else {
        failedTests++;
      }
    }
  }

  return {
    totalSuites: suites.length,
    totalTests,
    passedTests,
    failedTests,
    skippedTests,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    suites,
  };
}

// ============================================================================
// Strongly-Typed SlapRF Fixture Factories
// ============================================================================

const RACEBAND_FREQS = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const PILOT_COLORS = ["#d4ff3a", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa", "#2dd4bf", "#facc15", "#4ade80"];

export function makePilot(slotIndex: number, overrides: Partial<PilotSlot> = {}): PilotSlot {
  const ch = ((slotIndex - 1) % 8) + 1;
  return {
    slotIndex,
    callsign: `Pilot${slotIndex}`,
    phoneticName: "",
    enabled: true,
    band: 1,
    channel: ch,
    frequencyMhz: RACEBAND_FREQS[ch - 1],
    enterThreshold: -58,
    exitThreshold: -68,
    laprfThreshold: 800,
    attenuationGain: 59,
    color: PILOT_COLORS[(slotIndex - 1) % PILOT_COLORS.length],
    ...overrides,
  };
}

export function makeEventPilot(slotIndex: number, overrides: Partial<EventPilot> = {}): EventPilot {
  return {
    slotIndex,
    callsign: `Pilot${slotIndex}`,
    color: PILOT_COLORS[(slotIndex - 1) % PILOT_COLORS.length],
    checkedIn: true,
    attendance: "active",
    ...overrides,
  };
}

export function makeGate(gateId: number, overrides: Partial<TrackNode> = {}): TrackNode {
  return {
    gateId,
    assignedTimerId: gateId,
    name: "",
    role: gateId === 1 ? "START_FINISH" : "SECTOR_GATE",
    trackOrder: gateId - 1,
    mapX: 0.2 * gateId,
    mapY: 0.5,
    batteryMv: 4100,
    batteryPct: 92,
    noiseFloorDbm: -92,
    lastRssi: [-90, -90, -90, -90],
    enterThresholds: [0, 0, 0, 0],
    exitThresholds: [0, 0, 0, 0],
    laprfThresholds: [0, 0, 0, 0],
    ruleOverrides: {},
    online: true,
    lastSeenAt: "2026-11-13T20:00:00Z",
    framesRxCount: 100,
    ...overrides,
  };
}

export function makeDetectedTimer(timerId: number, overrides: Partial<DetectedTimer> = {}): DetectedTimer {
  return {
    timerId,
    timerLabel: timerId === 1 ? "H1" : `T${timerId - 1}`,
    isHub: timerId === 1,
    firmwareVersion: "v0.1.4",
    fingerprint: `AA00000${timerId}`,
    batteryMv: 4120,
    batteryPct: 95,
    noiseFloorDbm: -92,
    online: true,
    lastSeenAt: "2026-11-13T20:00:00Z",
    ...overrides,
  };
}

export function makeSectorSplit(
  sectorIndex: number,
  fromGateId: number,
  toGateId: number,
  splitSeconds: number,
  overrides: Partial<SectorSplit> = {}
): SectorSplit {
  return {
    sectorIndex,
    fromGateId,
    toGateId,
    label: `S${sectorIndex + 1}`,
    splitSeconds,
    deltaToBestSec: 0,
    exitSpeedMph: 45,
    badge: "NORMAL",
    ...overrides,
  };
}

export function makeLap(
  lapId: number,
  slotIndex: number,
  lapNumber: number,
  lapTimeSec: number,
  overrides: Partial<LapRecord> = {}
): LapRecord {
  return {
    lapId,
    slotIndex,
    callsign: `Pilot${slotIndex}`,
    lapNumber,
    lapTimeSec,
    deltaToBest: 0,
    sectors: [],
    completedAtUs: lapId * 1_000_000,
    isBestLap: false,
    ...overrides,
  };
}

export function makeCrossing(
  eventId: number,
  gateId: number,
  slotIndex: number,
  timestampUs: number,
  overrides: Partial<GateCrossingEvent> = {}
): GateCrossingEvent {
  return {
    eventId,
    gateId,
    gateName: gateId === 1 ? "Start/Finish" : `Gate ${gateId}`,
    isStartFinish: gateId === 1,
    slotIndex,
    callsign: `Pilot${slotIndex}`,
    frequencyMhz: 5658,
    timestampUs,
    peakRssiDbm: -45,
    laprfPeakHeight: 1600,
    beamwidthMs: 140,
    estimatedSpeedMph: 48,
    passingNumber: eventId,
    ...overrides,
  };
}

export function makeFiltered(
  timestampUs: number,
  gateId: number,
  slotIndex: number,
  reason: FilteredDetection["reason"] = "MIN_LAP",
  overrides: Partial<FilteredDetection> = {}
): FilteredDetection {
  return {
    timestampUs,
    gateId,
    slotIndex,
    callsign: `Pilot${slotIndex}`,
    reason,
    detail: "Too soon",
    peakRssiDbm: -50,
    ...overrides,
  };
}

export function makeHeatLap(
  crossingId: number,
  lapNumber: number,
  splitTimeSec: number,
  overrides: Partial<HeatLap> = {}
): HeatLap {
  return {
    crossingId,
    lapNumber,
    splitTimeSec,
    raceElapsedSec: lapNumber * splitTimeSec,
    invalidated: false,
    manual: false,
    ...overrides,
  };
}

export function makeSeat(seatIndex: number, pilotSlotIndex: number, overrides: Partial<HeatSeat> = {}): HeatSeat {
  const ch = [1, 3, 5, 8][seatIndex % 4];
  return {
    seatIndex,
    pilotSlotIndex,
    callsign: pilotSlotIndex > 0 ? `Pilot${pilotSlotIndex}` : "",
    color: pilotSlotIndex > 0 ? PILOT_COLORS[(pilotSlotIndex - 1) % PILOT_COLORS.length] : "#64748b",
    sourceLabel: pilotSlotIndex > 0 ? `Seed #${seatIndex + 1}` : "Open",
    band: 1,
    channel: ch,
    frequencyMhz: RACEBAND_FREQS[ch - 1],
    channelChanged: false,
    status: "staged",
    holeshotSec: 0,
    lapsCompleted: 0,
    totalTimeSec: 0,
    bestLapSec: 0,
    bestConsecutive3Sec: 0,
    lastLapSec: 0,
    penaltySec: 0,
    laps: [],
    position: 0,
    manualPosition: 0,
    points: 0,
    advances: false,
    ...overrides,
  };
}

export function makeHeat(id: string, overrides: Partial<RaceHeat> = {}): RaceHeat {
  return {
    id,
    roundId: "r-1",
    stageIndex: 1,
    stageName: "Main Stage",
    stageFormat: "double_elimination",
    round: 1,
    column: 1,
    order: 1,
    bracketLane: "winners",
    title: `Heat ${id}`,
    shortLabel: id,
    startMode: "heads_up",
    targetLaps: 3,
    timeLimitSec: 120,
    expectedWinners: 2,
    state: "staged",
    seats: [makeSeat(0, 1), makeSeat(1, 2), makeSeat(2, 3), makeSeat(3, 4)],
    elapsedSec: 0,
    countdownRemainingSec: 0,
    inOvertime: false,
    canUnlock: false,
    ...overrides,
  };
}

export function makeRound(id: string, overrides: Partial<RaceRound> = {}): RaceRound {
  return {
    id,
    stageIndex: 1,
    round: 1,
    column: 1,
    bracketLane: "winners",
    title: `Round ${id}`,
    stageFormat: "double_elimination",
    startMode: "heads_up",
    targetLaps: 3,
    timeLimitSec: 120,
    ...overrides,
  };
}

export function makeStage(index: number, overrides: Partial<RaceStage> = {}): RaceStage {
  return {
    id: `stage-${index}`,
    index,
    title: `Stage ${index}`,
    format: index === 1 ? "qualifying" : "double_elimination",
    status: index === 1 ? "active" : "pending",
    prerequisitesMet: index === 1,
    settings: {
      pilotsPerHeat: 4,
      seatChannels: [1, 3, 5, 8],
      targetLaps: 3,
      timeLimitSec: 120,
      qualifyingRounds: 2,
      qualifyingMetric: "consecutive_3",
    },
    ...overrides,
  };
}

export function makeRaceSetupConfig(overrides: Partial<RaceSetupConfig> = {}): RaceSetupConfig {
  return {
    eventName: "Friday Night Brawl",
    structure: "single_stage",
    qualifyingRounds: 2,
    qualifyingMetric: "consecutive_3",
    qualifyingTimeLimitSec: 120,
    qualifyingTargetLaps: 0,
    mainFormat: "double_elimination",
    finalsFormat: "chase_the_ace",
    aceWinsRequired: 2,
    winnersAdvantageAce: false,
    pointsRounds: 3,
    pilotsPerHeat: 4,
    seatChannels: [1, 3, 5, 8],
    targetLaps: 3,
    timeLimitSec: 120,
    countdownSec: 5,
    overtimeGraceSec: 15,
    seeding: "roster_order",
    ...overrides,
  };
}

export function makeRaceState(overrides: Partial<RaceTournamentState> = {}): RaceTournamentState {
  const cfg = makeRaceSetupConfig(overrides.config);
  return {
    raceId: "race-1",
    lifecycle: "draft",
    emergencyStopped: false,
    mode: "race",
    config: cfg,
    roster: [1, 2, 3, 4].map((s) => makeEventPilot(s)),
    stages: [makeStage(1, { format: cfg.mainFormat })],
    stageConnections: [] as StageConnection[],
    rounds: [makeRound("r-1")],
    connections: [] as RoundConnection[],
    generated: true,
    activeStageIndex: 1,
    totalStages: 1,
    qualifyingComplete: false,
    canStartStage2: false,
    activeHeatId: "W1-H1",
    nextReadyHeatId: "W1-H1",
    isComplete: false,
    heats: [makeHeat("W1-H1")],
    edges: [],
    standings: [],
    ...overrides,
  };
}

export function makePracticeSession(
  sessionId: string,
  overrides: Partial<PracticeSession> = {}
): PracticeSession {
  return {
    sessionId,
    name: `Warmup ${sessionId}`,
    tags: [],
    active: false,
    createdAt: "2026-11-13T19:00:00Z",
    pilots: [1, 2, 3, 4].map((i) => ({
      slotIndex: i,
      callsign: `Pilot${i}`,
      color: PILOT_COLORS[(i - 1) % PILOT_COLORS.length],
      band: 1,
      channel: ((i - 1) % 8) + 1,
      frequencyMhz: RACEBAND_FREQS[(i - 1) % 8],
    })),
    laps: [],
    crossings: [],
    filtered: [],
    summaries: [],
    ...overrides,
  };
}

export function makeDefaultRules(overrides: Partial<TimingRules> = {}): TimingRules {
  return {
    minLapSec: 5,
    maxLapSec: 120,
    minCrossingSec: 0.12,
    beepOnCross: false,
    ...overrides,
  };
}

export function makeFullState(overrides: Partial<FullStateResponse> = {}): FullStateResponse {
  const race = overrides.raceState ?? makeRaceState({ mode: "practice", generated: false, heats: [] });
  return {
    serverTimestampUs: 10_000_000,
    timingHardwareMode: "slaprf",
    pilots: [1, 2, 3, 4].map((s) => makePilot(s)),
    gates: [makeGate(1), makeGate(2), makeGate(3)],
    timers: [makeDetectedTimer(1), makeDetectedTimer(2), makeDetectedTimer(3)],
    laps: [],
    crossings: [],
    filtered: [],
    summaries: [],
    rules: makeDefaultRules(),
    simulatorRunning: true,
    raceArmed: true,
    laprfEmulatorStatus: {
      connectedClients: 0,
      detectionsSent: 0,
      statusFramesSent: 0,
      lastRfSetupSync: "",
      raceArmedByHost: true,
    },
    raceState: race,
    eventState: {
      initialized: true,
      activeRaceId: race.raceId ?? "",
      races: race.raceId ? [race] : [],
    },
    practiceState: {
      initialized: false,
      activeSessionId: "",
      selectedSessionId: "",
      sessions: [],
    },
    ...overrides,
  };
}

export function makeStore(overrides: Partial<FullStateResponse> = {}): AppStore {
  const store = new AppStore();
  store.hydrate(makeFullState(overrides));
  return store;
}

export interface MockApiClientRecord {
  api: ApiClient;
  calls: Array<{ method: string; args: unknown[] }>;
}

/**
 * Builds a lightweight fake `ApiClient` that records every method call without touching WASM,
 * allowing views & widgets (`RacesView`, `PracticeView`, `TopBar`, `TimingRulesEditor`, `BracketDiagram`)
 * to mount and dispatch user interactions deterministically in <1ms.
 */
export function makeMockApiClient(store: AppStore): MockApiClientRecord {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let viewingRaceId = "";
  const hubListeners = new Set<() => void>();

  const record =
    <TRet = void>(method: string, defaultRet?: TRet) =>
    (...args: unknown[]): Promise<TRet> => {
      calls.push({ method, args });
      return Promise.resolve(defaultRet as TRet);
    };

  const fake = {
    hubBridge: {
      subscribe: (cb: () => void) => {
        hubListeners.add(cb);
        return () => hubListeners.delete(cb);
      },
      status: () => ({ connected: false, portLabel: "", rxFrames: 0, lastError: "" }),
      isSupported: () => false,
      getLedSummary: () => ({ color: "green", shortLabel: "Armed", detail: "Ready" }),
    },
    usingBrowserRealEngine: false,
    setViewingRaceId: (id: string) => {
      viewingRaceId = id.trim();
    },
    getViewingRaceId: () => viewingRaceId,
    initialize: record("initialize"),
    refresh: record("refresh"),
    syncAfterDirectWasmCall: record("syncAfterDirectWasmCall"),
    toggleSimulator: record("toggleSimulator"),
    toggleArmed: record("toggleArmed"),
    simulatePack: record("simulatePack"),
    simPilotAction: record("simPilotAction"),
    setTrackWalker: record("setTrackWalker"),
    setSimSpeed: record("setSimSpeed"),
    simTimerAction: record("simTimerAction"),
    pollStatusNow: record("pollStatusNow"),
    resetSession: record("resetSession"),
    resetPilotsToDefault: record("resetPilotsToDefault"),
    resetTrackToDefault: record("resetTrackToDefault"),
    resetStoredData: record("resetStoredData"),
    wipeApplicationData: record("wipeApplicationData"),
    restoreDemoData: record("restoreDemoData"),
    exportApplicationData: record("exportApplicationData", {}),
    importApplicationData: record("importApplicationData"),
    updatePilotSlot: record("updatePilotSlot"),
    addPilot: record("addPilot"),
    removePilot: record("removePilot"),
    downloadPilotsRosterCsv: record("downloadPilotsRosterCsv", "callsign,phonetic_name,channel\n"),
    importPilotsRosterCsv: record("importPilotsRosterCsv", { added: 2, updated: 1, total: 135 }),
    setOperatingMode: record("setOperatingMode"),
    configureRace: record("configureRace"),
    advanceRaceStage2: record("advanceRaceStage2"),
    raceControl: record("raceControl"),
    raceMarshal: record("raceMarshal"),
    eventAction: record("eventAction"),
    stageControl: record("stageControl"),
    practiceAction: record("practiceAction"),
    bracketEdit: (...args: unknown[]) => {
      calls.push({ method: "bracketEdit", args });
      return Promise.resolve(store.raceState);
    },
    downloadRaceResultsCsv: record("downloadRaceResultsCsv"),
    tickRaceClock: record("tickRaceClock"),
    updateTrackNode: record("updateTrackNode"),
    updateGate: record("updateGate"),
    addTrackNode: record("addTrackNode"),
    addGate: record("addGate"),
    removeTrackNode: record("removeTrackNode"),
    removeGate: record("removeGate"),
    updateTimerColor: record("updateTimerColor"),
    deleteTimer: record("deleteTimer"),
    provisionTimer: record("provisionTimer"),
    fetchFirmwareImage: record("fetchFirmwareImage"),
    getRealEngineState: record("getRealEngineState", null),
    setGateThresholds: record("setGateThresholds"),
    setGateRules: record("setGateRules"),
    setPilotGateRules: record("setPilotGateRules"),
    updateRules: record("updateRules"),
    getVersionInfo: record("getVersionInfo", {
      release_tag: "(test)",
      commit_hash: "deadbeef",
      branch_name: "test",
    }),
    setTimingHardwareMode: record("setTimingHardwareMode"),
    simLapRFAction: record("simLapRFAction"),
    simLapRFDiscover: record("simLapRFDiscover", { subnet: "192.168.1.0/24", devices: [] }),
    simRotorHazardAction: record("simRotorHazardAction"),
    simRotorHazardDiscover: record("simRotorHazardDiscover", { subnet: "192.168.1.0/24", devices: [] }),
    setRHDebugStream: record("setRHDebugStream"),
    runRHUSBScan: (payload: {
      timerId: number;
      mode: "once" | "live" | "stop";
      start: number;
      stop: number;
      step: number;
    }) => {
      calls.push({ method: "runRHUSBScan", args: [payload] });
      const start = payload.start || 5180;
      const stop = Math.min(5917, payload.stop || 5917);
      const step = payload.step || 5;
      const bins = Math.floor((stop - start) / step) + 1;
      const values = Array.from({ length: bins }, (_, idx) => {
        const f = start + idx * step;
        return Math.abs(f - 5805) <= 5 ? 196 : 24;
      });
      return Promise.resolve({
        ok: true,
        scanLive: payload.mode === "live",
        scan:
          payload.mode === "once"
            ? {
                seq: 1,
                start,
                stop: start + (bins - 1) * step,
                step,
                passMs: 120,
                live: false,
                values,
              }
            : undefined,
      });
    },
    simMultiGPWebService: record("simMultiGPWebService", { status: true }),
    simMultiGPAdmin: record("simMultiGPAdmin"),
    multiGPImportRace: record("multiGPImportRace"),
    multiGPAppendZippyQ: record("multiGPAppendZippyQ"),
    multiGPBuildSyncPlan: record("multiGPBuildSyncPlan", {
      raceId: "race-1",
      mgpRaceId: 1,
      mgpRaceName: "Test",
      importMode: "schedule",
      operations: [],
    }),
    multiGPMarkSynced: record("multiGPMarkSynced"),
  };

  return {
    api: fake as unknown as ApiClient,
    calls,
  };
}
