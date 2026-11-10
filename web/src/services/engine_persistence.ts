/**
 * Engine state persistence in IndexedDB (see storage_idb.ts for the schema).
 *
 * The Go/WASM engines are the source of truth; IndexedDB is a durable mirror:
 *
 * - Hot path (real engine only): `lap` / `crossing` / `filtered` stream events are queued and
 *   appended in ONE batched transaction every ~500 ms (telemetry is never persisted). Records use
 *   the engine's natural keys (lapId, eventId, [timestampUs, gateId, slotIndex, reason]), so a
 *   record written twice (append + reconcile) is idempotent.
 * - Full reconcile: export the whole engine state from WASM and replace the event stores + config
 *   documents in ONE transaction. Triggered by every POST (all config / reset / import endpoints),
 *   by `config` stream events, every 15 s while anything changed (also trims the engine's ring
 *   buffers: 300 crossings, 300 filtered, 5000 laps), on tab hide / pagehide, and on
 *   export / import / wipe. A reconcile drops the pending append queue: the export already contains
 *   every event delivered so far (events are dispatched after the engine records them).
 * - Writes are disabled until the boot restore has completed successfully (never persist the
 *   empty default engine over real data) and while another tab holds the writer lock.
 *
 * Boot: `loadBootState()` runs in parallel with the wasm download, assembles the
 * `tracker.PersistedEngineState` JSON from the stores and hands it to the Go runtime through
 * `window.__slaprfBootState` (read once in cmd/slaprf-wasm main before the simulator starts), so
 * the first `/api/state` the UI fetches already contains the restored data.
 */

import { isDevHost } from "./offline";
import { ALL_STORES, IdbError, openDatabase, SlaprfDb, STORE_CROSSINGS, STORE_FILTERED, STORE_KV, STORE_LAPS, WriteOp } from "./storage_idb";

/** Pre-IndexedDB engine-state keys; deleted on startup (no migration by design). */
export const LEGACY_LOCALSTORAGE_KEYS = ["slaprf.sim_state.v1", "slaprf.real_state.v1", "slaprf.real_state_backup.v1"];
export const LAST_BACKUP_STORAGE_KEY = "slaprf.ui.last_backup.v1";
export const WRITER_LOCK_NAME = "slaprf-engine-writer";

export const KV_REAL_CONFIG = "real.config";
export const KV_SIM_STATE = "sim.state";
export const KV_META = "meta";

const APPEND_FLUSH_MS = 500;
const STRUCTURAL_DEBOUNCE_MS = 250;
const PERIODIC_RECONCILE_MS = 15_000;
const INITIAL_RECONCILE_MS = 2_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM / IndexedDB access) — keep these side-effect free.
// ---------------------------------------------------------------------------------------------

/** JSON shape of Go `tracker.PersistedEngineState` (fields are passed through untouched). */
export interface PersistedEngineStateJson {
  elapsedUs: number;
  raceArmed: boolean;
  rules: unknown;
  pilots: unknown[] | null;
  gates: unknown[] | null;
  timers: unknown[] | null;
  deletedSpokeFp?: string[] | null;
  laps: unknown[] | null;
  crossings: unknown[] | null;
  filtered: unknown[] | null;
}

/** `kv` document holding everything of the real engine except the per-event records. */
export interface RealConfigDoc {
  key: typeof KV_REAL_CONFIG;
  elapsedUs: number;
  raceArmed: boolean;
  rules: unknown;
  pilots: unknown[] | null;
  gates: unknown[] | null;
  timers: unknown[] | null;
  deletedSpokeFp?: string[] | null;
}

export interface SimStateDoc {
  key: typeof KV_SIM_STATE;
  /** Raw `exportSimState()` JSON (engine + simulator options); synthetic and small, stored as one blob. */
  json: string;
}

export interface MetaDoc {
  key: typeof KV_META;
  schema: 1;
  savedAt: number;
}

type Rec = Record<string, unknown>;

function isKeyNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** True when the record has a valid primary key for its store (an invalid key would abort the whole batch). */
export function hasValidKey(store: "laps" | "crossings" | "filtered", rec: unknown): boolean {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Rec;
  switch (store) {
    case "laps":
      return isKeyNumber(r.lapId);
    case "crossings":
      return isKeyNumber(r.eventId);
    case "filtered":
      return isKeyNumber(r.timestampUs) && isKeyNumber(r.gateId) && isKeyNumber(r.slotIndex) && typeof r.reason === "string";
  }
}

function validRecords(store: "laps" | "crossings" | "filtered", list: unknown[] | null | undefined): Rec[] {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => hasValidKey(store, r)) as Rec[];
}

/** Splits an exported engine state into the config document + per-store event records. */
export function splitRealState(state: PersistedEngineStateJson): {
  config: RealConfigDoc;
  laps: Rec[];
  crossings: Rec[];
  filtered: Rec[];
} {
  return {
    config: {
      key: KV_REAL_CONFIG,
      elapsedUs: isKeyNumber(state.elapsedUs) ? state.elapsedUs : 0,
      raceArmed: !!state.raceArmed,
      rules: state.rules ?? null,
      pilots: state.pilots ?? null,
      gates: state.gates ?? null,
      timers: state.timers ?? null,
      deletedSpokeFp: state.deletedSpokeFp ?? null,
    },
    laps: validRecords("laps", state.laps),
    crossings: validRecords("crossings", state.crossings),
    filtered: validRecords("filtered", state.filtered),
  };
}

function num(v: unknown): number {
  return isKeyNumber(v) ? v : 0;
}

/**
 * Rebuilds a `PersistedEngineState` from stored documents. Event lists are sorted into engine
 * order (lapId / eventId are monotonic within the engine; filtered detections by time) — the Go
 * side keeps only the newest N of each, exactly like its in-memory ring buffers.
 * Returns null when nothing was ever stored (fresh install → engine keeps its defaults).
 */
export function assembleRealState(
  config: RealConfigDoc | undefined | null,
  laps: unknown[],
  crossings: unknown[],
  filtered: unknown[]
): PersistedEngineStateJson | null {
  const l = validRecords("laps", laps).sort((a, b) => num(a.lapId) - num(b.lapId));
  const c = validRecords("crossings", crossings).sort((a, b) => num(a.eventId) - num(b.eventId));
  const f = validRecords("filtered", filtered).sort((a, b) => num(a.timestampUs) - num(b.timestampUs));
  if (!config && l.length === 0 && c.length === 0 && f.length === 0) return null;
  return {
    elapsedUs: config ? num(config.elapsedUs) : 0,
    raceArmed: config ? !!config.raceArmed : true,
    rules: config?.rules ?? {},
    pilots: config?.pilots ?? null,
    gates: config?.gates ?? null,
    timers: config?.timers ?? null,
    deletedSpokeFp: config?.deletedSpokeFp ?? null,
    laps: l,
    crossings: c,
    filtered: f,
  };
}

/** Ops that replace the real engine's stores with `state` (used inside one transaction). */
export function realReplaceOps(state: PersistedEngineStateJson): WriteOp[] {
  const s = splitRealState(state);
  return [
    { op: "clear", store: STORE_LAPS },
    { op: "clear", store: STORE_CROSSINGS },
    { op: "clear", store: STORE_FILTERED },
    { op: "putAll", store: STORE_LAPS, values: s.laps },
    { op: "putAll", store: STORE_CROSSINGS, values: s.crossings },
    { op: "putAll", store: STORE_FILTERED, values: s.filtered },
    { op: "put", store: STORE_KV, value: s.config },
  ];
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

export interface EngineExportBridge {
  exportRealState?(): string;
  exportSimState?(): string;
}

export interface BootState {
  /** `PersistedEngineState` JSON for the real engine, or null for a fresh engine. */
  real: string | null;
  /** `exportSimState()` JSON (engine + simulator options), or null for a fresh, pre-warmed simulator. */
  sim: string | null;
}

export type PersistenceMode = "booting" | "active" | "read-only" | "unavailable";

export interface PersistenceStatus {
  backend: "IndexedDB";
  mode: PersistenceMode;
  /** Epoch ms of the last committed write (from IndexedDB meta on boot, then live). */
  lastSavedAt: number | null;
  lastError: string | null;
  /** Read-only tab: the writer tab has gone away; reloading this tab will make it the writer. */
  takeoverAvailable: boolean;
  restoredLaps: number;
}

function errText(err: unknown): string {
  if (err instanceof IdbError) return err.message;
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class EnginePersistence {
  private db: SlaprfDb | null = null;
  private bridge: EngineExportBridge | null = null;
  private bootPromise: Promise<BootState> | null = null;
  private writer = false;
  private loadOk = false;
  private enabled = false;
  private mode: PersistenceMode = "booting";
  private lastSavedAt: number | null = null;
  private lastError: string | null = null;
  private takeoverAvailable = false;
  private restoredLaps = 0;

  private pendingLaps: Rec[] = [];
  private pendingCrossings: Rec[] = [];
  private pendingFiltered: Rec[] = [];
  private appendTimer: number | null = null;
  private structuralTimer: number | null = null;
  private periodicTimer: number | null = null;
  private realDirty = false;
  private simDirty = false;
  private readonly listeners = new Set<() => void>();

  /** Opens IndexedDB, takes the writer lock (if free) and reads the persisted state. Never rejects. */
  public loadBootState(): Promise<BootState> {
    if (!this.bootPromise) this.bootPromise = this.doLoad();
    return this.bootPromise;
  }

  private async doLoad(): Promise<BootState> {
    removeLegacyKeys();
    const empty: BootState = { real: null, sim: null };
    const [writer, opened] = await Promise.all([
      acquireWriterLock(() => {
        this.takeoverAvailable = true;
        this.emit();
      }),
      openDatabase().then(
        (db) => ({ db, err: null as unknown }),
        (err: unknown) => ({ db: null, err })
      ),
    ]);
    this.writer = writer;
    if (!opened.db) {
      this.fail(`IndexedDB unavailable: ${errText(opened.err)}`);
      return empty;
    }
    this.db = opened.db;
    try {
      const data = await this.db.readStores(ALL_STORES);
      const kv = new Map<string, Rec>();
      for (const doc of data[STORE_KV] as Rec[]) kv.set(String(doc.key), doc);
      const real = assembleRealState(
        kv.get(KV_REAL_CONFIG) as RealConfigDoc | undefined,
        data[STORE_LAPS],
        data[STORE_CROSSINGS],
        data[STORE_FILTERED]
      );
      const simDoc = kv.get(KV_SIM_STATE) as Partial<SimStateDoc> | undefined;
      const meta = kv.get(KV_META) as Partial<MetaDoc> | undefined;
      this.lastSavedAt = typeof meta?.savedAt === "number" ? meta.savedAt : null;
      this.restoredLaps = real?.laps?.length ?? 0;
      this.loadOk = true;
      return {
        real: real ? JSON.stringify(real) : null,
        sim: typeof simDoc?.json === "string" && simDoc.json ? simDoc.json : null,
      };
    } catch (err) {
      // Unreadable data: start fresh in memory but NEVER overwrite what is on disk.
      this.fail(`could not read saved state: ${errText(err)}`);
      return empty;
    }
  }

  private fail(msg: string): void {
    console.error(`[storage] ${msg}: engine state will not be saved in this tab.`);
    this.mode = "unavailable";
    this.lastError = msg;
    this.enabled = false;
    this.emit();
  }

  /** Called once the WASM engine is running with the boot state applied; enables writes. */
  public attach(bridge: EngineExportBridge): void {
    this.bridge = bridge;
    if (!this.loadOk) {
      this.mode = "unavailable";
      this.emit();
      return;
    }
    if (!this.writer) {
      this.mode = "read-only";
      showReadOnlyBanner(this);
      this.emit();
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
    this.mode = "active";
    this.periodicTimer = window.setInterval(() => this.periodicTick(), PERIODIC_RECONCILE_MS);
    const flush = () => this.flushNow();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    // First save shortly after boot (fresh install: writes defaults; otherwise refreshes config/meta).
    this.realDirty = true;
    this.simDirty = true;
    this.scheduleStructural(INITIAL_RECONCILE_MS);
    this.emit();
  }

  public get canWrite(): boolean {
    return this.enabled;
  }

  /** Stream envelope hook (all non-telemetry events). `simRunning` tells which engine emitted it. */
  public onStreamEvent(type: string, payload: unknown, simRunning: boolean): void {
    if (!this.enabled || type === "telemetry" || type === "connected") return;
    if (simRunning) {
      this.simDirty = true;
      return;
    }
    this.realDirty = true;
    switch (type) {
      case "lap": {
        const lap = (payload as { lap?: unknown } | null)?.lap;
        if (hasValidKey("laps", lap)) this.pendingLaps.push({ ...(lap as Rec) });
        break;
      }
      case "crossing":
        if (hasValidKey("crossings", payload)) this.pendingCrossings.push({ ...(payload as Rec) });
        break;
      case "filtered":
        if (hasValidKey("filtered", payload)) this.pendingFiltered.push({ ...(payload as Rec) });
        break;
      case "config":
        // Pilot / track changes (also from hub identity packets): replace everything.
        this.scheduleStructural(STRUCTURAL_DEBOUNCE_MS);
        return;
      default:
        return;
    }
    if (this.appendTimer === null) {
      this.appendTimer = window.setTimeout(() => this.flushAppends(), APPEND_FLUSH_MS);
    }
  }

  /** Real-engine input outside the stream (hub packets: timer registration, battery, …). Cheap. */
  public noteRealActivity(): void {
    if (this.enabled) this.realDirty = true;
  }

  /** Any mutating API call (config, resets, imports): full reconcile of both engines, debounced. */
  public notePost(): void {
    if (!this.enabled) return;
    this.realDirty = true;
    this.simDirty = true;
    this.scheduleStructural(STRUCTURAL_DEBOUNCE_MS);
  }

  /** Synchronously starts a reconcile transaction for whatever is dirty (pagehide / tab hidden). */
  public flushNow(): void {
    if (!this.enabled) return;
    this.cancelTimers();
    const real = this.realDirty || this.pendingCount() > 0;
    if (!real && !this.simDirty) return;
    void this.reconcile(real, this.simDirty).catch(() => undefined);
  }

  /** Full reconcile of both engines; resolves once committed (export / import). */
  public reconcileNow(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.cancelTimers();
    return this.reconcile(true, true);
  }

  /**
   * Wipe: clears every store and writes the (already reset) engines' default state in ONE
   * transaction, so a crash in between can never leave half-wiped data.
   */
  public wipeAndReconcile(): Promise<void> {
    if (!this.enabled || !this.db) return Promise.resolve();
    this.cancelTimers();
    const ops: WriteOp[] = ALL_STORES.map((store) => ({ op: "clear" as const, store }));
    ops.push(...this.reconcileOps(true, true));
    return this.commit(ops, true, true);
  }

  public getStatus(): PersistenceStatus {
    return {
      backend: "IndexedDB",
      mode: this.mode,
      lastSavedAt: this.lastSavedAt,
      lastError: this.lastError,
      takeoverAvailable: this.takeoverAvailable,
      restoredLaps: this.restoredLaps,
    };
  }

  public subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        console.error("[storage] status listener failed:", err);
      }
    }
  }

  private pendingCount(): number {
    return this.pendingLaps.length + this.pendingCrossings.length + this.pendingFiltered.length;
  }

  private cancelTimers(): void {
    if (this.appendTimer !== null) {
      window.clearTimeout(this.appendTimer);
      this.appendTimer = null;
    }
    if (this.structuralTimer !== null) {
      window.clearTimeout(this.structuralTimer);
      this.structuralTimer = null;
    }
  }

  private scheduleStructural(delayMs: number): void {
    if (this.structuralTimer !== null) window.clearTimeout(this.structuralTimer);
    this.structuralTimer = window.setTimeout(() => {
      this.structuralTimer = null;
      if (!this.realDirty && !this.simDirty && this.pendingCount() === 0) return;
      void this.reconcile(true, this.simDirty).catch(() => undefined);
    }, delayMs);
  }

  private periodicTick(): void {
    if (!this.enabled || this.structuralTimer !== null) return;
    const real = this.realDirty || this.pendingCount() > 0;
    if (!real && !this.simDirty) return;
    void this.reconcile(real, this.simDirty).catch(() => undefined);
  }

  private flushAppends(): void {
    this.appendTimer = null;
    if (!this.enabled || this.pendingCount() === 0) return;
    const ops: WriteOp[] = [];
    if (this.pendingLaps.length) ops.push({ op: "putAll", store: STORE_LAPS, values: this.pendingLaps });
    if (this.pendingCrossings.length) ops.push({ op: "putAll", store: STORE_CROSSINGS, values: this.pendingCrossings });
    if (this.pendingFiltered.length) ops.push({ op: "putAll", store: STORE_FILTERED, values: this.pendingFiltered });
    this.pendingLaps = [];
    this.pendingCrossings = [];
    this.pendingFiltered = [];
    void this.commit(ops, true, false).catch(() => undefined);
  }

  /** Builds (synchronously, from the live engines) the ops for a reconcile. Clears dirty flags it covers. */
  private reconcileOps(real: boolean, sim: boolean): WriteOp[] {
    const ops: WriteOp[] = [];
    const bridge = this.bridge;
    if (!bridge) return ops;
    if (real && typeof bridge.exportRealState === "function") {
      const raw = bridge.exportRealState();
      if (raw) {
        ops.push(...realReplaceOps(JSON.parse(raw) as PersistedEngineStateJson));
        // The export contains every event delivered so far: drop the append queue.
        this.pendingLaps = [];
        this.pendingCrossings = [];
        this.pendingFiltered = [];
        if (this.appendTimer !== null) {
          window.clearTimeout(this.appendTimer);
          this.appendTimer = null;
        }
        this.realDirty = false;
      }
    }
    if (sim && typeof bridge.exportSimState === "function") {
      const raw = bridge.exportSimState();
      if (raw) {
        const doc: SimStateDoc = { key: KV_SIM_STATE, json: raw };
        ops.push({ op: "put", store: STORE_KV, value: doc });
        this.simDirty = false;
      }
    }
    return ops;
  }

  private reconcile(real: boolean, sim: boolean): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    let ops: WriteOp[];
    try {
      ops = this.reconcileOps(real, sim);
    } catch (err) {
      this.lastError = `export failed: ${errText(err)}`;
      this.emit();
      return Promise.reject(err);
    }
    if (ops.length === 0) return Promise.resolve();
    return this.commit(ops, real, sim);
  }

  private commit(ops: WriteOp[], realTouched: boolean, simTouched: boolean): Promise<void> {
    const db = this.db;
    if (!db || ops.length === 0) return Promise.resolve();
    const savedAt = Date.now();
    const meta: MetaDoc = { key: KV_META, schema: 1, savedAt };
    return db.writeTx([...ops, { op: "put", store: STORE_KV, value: meta }]).then(
      () => {
        this.lastSavedAt = savedAt;
        this.lastError = null;
        this.emit();
      },
      (err: unknown) => {
        // Retry everything on the next reconcile (quota errors stay visible in the status line).
        if (realTouched) this.realDirty = true;
        if (simTouched) this.simDirty = true;
        this.lastError = `save failed: ${errText(err)}`;
        console.warn("[storage] IndexedDB write failed:", err);
        this.emit();
        throw err;
      }
    );
  }
}

function removeLegacyKeys(): void {
  try {
    for (const k of LEGACY_LOCALSTORAGE_KEYS) window.localStorage.removeItem(k);
  } catch {
    /* storage access denied */
  }
}

interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
  request(name: string, cb: (lock: unknown) => unknown): Promise<unknown>;
}

/**
 * Tries to take the cross-tab writer lock without waiting. Resolves true when this tab is the
 * writer (or the Web Locks API is unavailable). A read-only tab also queues a plain request so it
 * learns when the writer tab goes away (`onTakeoverAvailable`); it then releases it immediately —
 * it must reload (re-read IndexedDB) before writing, or it would overwrite newer data.
 */
function acquireWriterLock(onTakeoverAvailable: () => void): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  if (!locks || typeof locks.request !== "function") return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    locks
      .request(WRITER_LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          void locks.request(WRITER_LOCK_NAME, () => onTakeoverAvailable()).catch(() => undefined);
          return undefined;
        }
        resolve(true);
        // Hold the lock for the lifetime of the page.
        return new Promise<void>(() => undefined);
      })
      .catch((err: unknown) => {
        console.warn("[storage] Web Locks unavailable, assuming single tab:", err);
        resolve(true);
      });
  });
}

function showReadOnlyBanner(p: EnginePersistence): void {
  if (document.getElementById("slaprf-readonly-banner")) return;
  const el = document.createElement("div");
  el.id = "slaprf-readonly-banner";
  el.className = "storage-banner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const render = () => {
    const takeover = p.getStatus().takeoverAvailable;
    el.innerHTML = `
      <span class="storage-banner-text">${
        takeover
          ? "The other SlapRF tab was closed. Reload to save changes from this tab."
          : "SlapRF is open in another tab. This tab is read-only (changes here are not saved)."
      }</span>
      <button type="button" class="btn btn-ghost btn-sm" data-action="reload">Reload</button>`;
    el.querySelector<HTMLButtonElement>('[data-action="reload"]')?.addEventListener("click", () => window.location.reload());
  };
  render();
  p.subscribe(render);
  document.body.appendChild(el);
}

export function getLastBackupAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_BACKUP_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function recordBackupNow(): void {
  try {
    window.localStorage.setItem(LAST_BACKUP_STORAGE_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

const persistenceWin = (typeof window !== "undefined" ? window : undefined) as
  | (Window & { __slaprfPersistence?: EnginePersistence })
  | undefined;

/** App-wide singleton (one WASM runtime per page, preserved across dev HMR). */
export const enginePersistence: EnginePersistence = (() => {
  if (persistenceWin?.__slaprfPersistence) {
    Object.setPrototypeOf(persistenceWin.__slaprfPersistence, EnginePersistence.prototype);
    return persistenceWin.__slaprfPersistence;
  }
  const inst = new EnginePersistence();
  if (persistenceWin && isDevHost()) {
    persistenceWin.__slaprfPersistence = inst;
  }
  return inst;
})();
