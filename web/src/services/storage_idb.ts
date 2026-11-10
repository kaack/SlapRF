/**
 * Minimal hand-written promise wrapper around IndexedDB (no external packages).
 *
 * Schema (database "slaprf", version 1):
 * - `kv`        keyPath "key"                                   config documents ("real.config", "sim.state", "meta")
 * - `laps`      keyPath "lapId"                                 one record per real-engine LapRecord, index "completedAtUs"
 * - `crossings` keyPath "eventId"                               one record per real-engine GateCrossingEvent, index "timestampUs"
 * - `filtered`  keyPath ["timestampUs","gateId","slotIndex","reason"]  one record per FilteredDetection, index "timestampUs"
 *
 * All writes go through `writeTx`, which creates its transaction synchronously. IndexedDB runs
 * read-write transactions with overlapping scopes strictly in creation order, so callers get a
 * total write order without an extra JS-side queue (important for `pagehide` flushes, which must
 * start their transaction before the handler returns).
 */

export const DB_NAME = "slaprf";
export const DB_VERSION = 1;

export const STORE_KV = "kv";
export const STORE_LAPS = "laps";
export const STORE_CROSSINGS = "crossings";
export const STORE_FILTERED = "filtered";

export const EVENT_STORES = [STORE_LAPS, STORE_CROSSINGS, STORE_FILTERED] as const;
export const ALL_STORES = [STORE_KV, ...EVENT_STORES] as const;
export type StoreName = (typeof ALL_STORES)[number];

/** Upgrade handler for the versioned schema; add `if (oldVersion < 2) { ... }` blocks for future versions. */
function upgradeSchema(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore(STORE_KV, { keyPath: "key" });
    const laps = db.createObjectStore(STORE_LAPS, { keyPath: "lapId" });
    laps.createIndex("completedAtUs", "completedAtUs");
    const crossings = db.createObjectStore(STORE_CROSSINGS, { keyPath: "eventId" });
    crossings.createIndex("timestampUs", "timestampUs");
    const filtered = db.createObjectStore(STORE_FILTERED, {
      keyPath: ["timestampUs", "gateId", "slotIndex", "reason"],
    });
    filtered.createIndex("timestampUs", "timestampUs");
  }
}

export class IdbError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IdbError";
  }
}

function describe(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new IdbError(describe(req.error), req.error));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new IdbError(`transaction aborted: ${describe(tx.error)}`, tx.error));
    tx.onerror = () => {
      /* surfaced via onabort (errors abort the transaction unless prevented) */
    };
  });
}

/** Open (and create/upgrade) the SlapRF database. Rejects with an IdbError on failure or when blocked too long. */
export function openDatabase(name = DB_NAME, version = DB_VERSION, timeoutMs = 8000): Promise<SlaprfDb> {
  return new Promise<SlaprfDb>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new IdbError("IndexedDB is not available in this browser"));
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new IdbError("timed out opening IndexedDB (blocked by another tab?)"));
    }, timeoutMs);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name, version);
    } catch (err) {
      window.clearTimeout(timer);
      reject(new IdbError(describe(err), err));
      return;
    }
    req.onupgradeneeded = (ev) => {
      upgradeSchema(req.result, ev.oldVersion);
    };
    req.onsuccess = () => {
      window.clearTimeout(timer);
      const db = req.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      resolve(new SlaprfDb(db));
    };
    req.onerror = () => {
      window.clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new IdbError(`open failed: ${describe(req.error)}`, req.error));
    };
    req.onblocked = () => {
      console.warn("[storage] IndexedDB open blocked by another connection; waiting…");
    };
  });
}

/** One operation inside a batched write transaction. */
export type WriteOp =
  | { op: "put"; store: StoreName; value: unknown }
  | { op: "putAll"; store: StoreName; values: readonly unknown[] }
  | { op: "delete"; store: StoreName; key: IDBValidKey }
  | { op: "clear"; store: StoreName };

export class SlaprfDb {
  constructor(readonly db: IDBDatabase) {
    // Another tab/version upgrade asks us to let go: close so it isn't blocked forever.
    db.onversionchange = () => db.close();
  }

  close(): void {
    this.db.close();
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const tx = this.db.transaction(store, "readonly");
    return (await reqPromise(tx.objectStore(store).get(key))) as T | undefined;
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    const tx = this.db.transaction(store, "readonly");
    return (await reqPromise(tx.objectStore(store).getAll())) as T[];
  }

  /** Reads several whole stores in ONE readonly transaction (consistent snapshot), in key order. */
  async readStores(stores: readonly StoreName[]): Promise<Record<string, unknown[]>> {
    const tx = this.db.transaction(stores as StoreName[], "readonly");
    const out: Record<string, unknown[]> = {};
    await Promise.all(
      stores.map(async (s) => {
        out[s] = (await reqPromise(tx.objectStore(s).getAll())) as unknown[];
      })
    );
    await txDone(tx);
    return out;
  }

  async count(store: StoreName): Promise<number> {
    const tx = this.db.transaction(store, "readonly");
    return reqPromise(tx.objectStore(store).count());
  }

  put(store: StoreName, value: unknown): Promise<void> {
    return this.writeTx([{ op: "put", store, value }]);
  }

  putAll(store: StoreName, values: readonly unknown[]): Promise<void> {
    return this.writeTx([{ op: "putAll", store, values }]);
  }

  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    return this.writeTx([{ op: "delete", store, key }]);
  }

  clear(store: StoreName): Promise<void> {
    return this.writeTx([{ op: "clear", store }]);
  }

  clearAll(): Promise<void> {
    return this.writeTx(ALL_STORES.map((store) => ({ op: "clear" as const, store })));
  }

  /**
   * Applies all ops atomically in a single read-write transaction. The transaction is created and
   * all requests are issued synchronously (before this function returns); the promise settles on
   * commit/abort. Any failing request aborts the whole batch.
   */
  writeTx(ops: readonly WriteOp[]): Promise<void> {
    const stores = Array.from(new Set(ops.map((o) => o.store)));
    if (stores.length === 0) return Promise.resolve();
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction(stores, "readwrite");
    } catch (err) {
      return Promise.reject(new IdbError(describe(err), err));
    }
    const done = txDone(tx);
    try {
      for (const o of ops) {
        const os = tx.objectStore(o.store);
        switch (o.op) {
          case "put":
            os.put(o.value);
            break;
          case "putAll":
            for (const v of o.values) os.put(v);
            break;
          case "delete":
            os.delete(o.key);
            break;
          case "clear":
            os.clear();
            break;
        }
      }
      // Hint the browser to commit right away (helps pagehide flushes); not available everywhere.
      (tx as IDBTransaction & { commit?: () => void }).commit?.();
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      done.catch(() => undefined);
      return Promise.reject(new IdbError(describe(err), err));
    }
    return done;
  }
}

/** Deletes the whole database (used by tests/diagnostics; the app's wipe clears stores instead). */
export function deleteDatabase(name = DB_NAME): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new IdbError(describe(req.error), req.error));
    req.onblocked = () => console.warn("[storage] deleteDatabase blocked by an open connection");
  });
}
