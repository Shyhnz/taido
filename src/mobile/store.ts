/**
 * Storage of the phone's persisted set (docs/SYNC.md § 6.2): IndexedDB database `todo`,
 * version 1, object store `kv`, one key per part of `Persisted`. `save` writes the five keys in
 * one `readwrite` transaction (all or nothing); `load` refuses a partial set so the app never
 * diffs a torn state against its snapshot.
 *
 * `sync` lives under `SYNC_KEY` (persisted.ts). A set saved before is
 * moved by the first `load`, in the same transaction that reads it; every `save` removes the
 * old keys. An older build then finds four parts of five and refuses the set (`assemble`
 * throws, the app starts empty and never saves nor syncs): it can no longer send a deletion of
 * every row it does not know. A new IndexedDB version would do the same but blocks or closes
 * the pages of the other build; a moved key changes nothing for them until they load.
 */

import {
  LEGACY_SYNC_KEYS,
  PERSISTED_KEYS,
  type Persisted,
  STORAGE_KEYS,
  SYNC_KEY,
} from "./persisted";

export interface MobileStore {
  /** The stored set, or `null` when nothing was ever saved. Rejects an inconsistent set. */
  load(): Promise<Persisted | null>;
  /** Writes the whole set atomically; rejects when the transaction fails. */
  save(p: Persisted): Promise<void>;
}

/** Some keys are stored and others are missing: never use such a set. */
export class InconsistentStoreError extends Error {
  constructor(present: string[]) {
    super(`inconsistent persisted set (present: ${present.join(", ")})`);
    this.name = "InconsistentStoreError";
  }
}

/** Parts by name, as read from the store. */
type Parts = Partial<Record<keyof Persisted, unknown>>;

/** Checks the five parts; `null` when none is present. */
export function assemble(parts: Parts): Persisted | null {
  const present = PERSISTED_KEYS.filter((k) => parts[k] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== PERSISTED_KEYS.length) {
    throw new InconsistentStoreError(present);
  }
  const state = parts.state as Persisted["state"] | null;
  if (
    typeof state !== "object" ||
    state === null ||
    !Array.isArray(state.subjects) ||
    !Array.isArray(state.sections) ||
    !Array.isArray(state.tasks)
  ) {
    throw new InconsistentStoreError(present);
  }
  return parts as Persisted;
}

/** Every key `load` reads: the five parts, and `sync` where older builds keep it. */
const READ_KEYS = [
  ...PERSISTED_KEYS.map((k) => STORAGE_KEYS[k]),
  ...LEGACY_SYNC_KEYS,
];

/**
 * The parts from the stored keys: `sync` from `SYNC_KEY`, else from the newest of
 * `LEGACY_SYNC_KEYS` (a set saved by an older build). `legacy`: an old key is there and must
 * go (moved first when `SYNC_KEY` is missing).
 */
export function partsOf(raw: Readonly<Record<string, unknown>>): {
  parts: Parts;
  legacy: boolean;
} {
  const parts: Parts = {};
  for (const k of PERSISTED_KEYS) parts[k] = raw[STORAGE_KEYS[k]];
  const old = LEGACY_SYNC_KEYS.filter((k) => raw[k] !== undefined);
  if (parts.sync === undefined && old.length > 0) parts.sync = raw[old[0]];
  return { parts, legacy: old.length > 0 };
}

export const DB_NAME = "todo";
export const DB_VERSION = 1;
export const STORE_NAME = "kv";

/** IndexedDB implementation (the factory is injectable for tests). */
export class IndexedDbStore implements MobileStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const request = this.factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("indexedDB open blocked"));
      });
      // A failed open may succeed later (e.g. after freeing space).
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  /**
   * Reads the set and, when it was saved by an older build, moves `sync` to `SYNC_KEY` in the
   * same transaction. When that write cannot be made (a full device), the set is read without
   * it: the next save moves it.
   */
  async load(): Promise<Persisted | null> {
    try {
      return await this.read("readwrite");
    } catch (error) {
      if (error instanceof InconsistentStoreError) throw error;
      console.warn("storage: cannot move the sync key, reading only", error);
      return this.read("readonly");
    }
  }

  private async read(mode: IDBTransactionMode): Promise<Persisted | null> {
    const db = await this.open();
    return new Promise<Persisted | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const raw: Record<string, unknown> = {};
      let result: Persisted | null = null;
      let refused: unknown = null;
      let left = READ_KEYS.length;
      for (const key of READ_KEYS) {
        const req = store.get(key);
        req.onsuccess = () => {
          raw[key] = req.result;
          left -= 1;
          if (left > 0) return;
          const { parts, legacy } = partsOf(raw);
          try {
            result = assemble(parts);
          } catch (error) {
            // Never written over: kept as it is for a later build or a diagnosis.
            refused = error;
            return;
          }
          if (legacy && mode === "readwrite") {
            if (raw[SYNC_KEY] === undefined) store.put(parts.sync, SYNC_KEY);
            for (const k of LEGACY_SYNC_KEYS) store.delete(k);
          }
        };
      }
      tx.oncomplete = () => {
        if (refused !== null) reject(refused);
        else resolve(result);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("load aborted"));
    });
  }

  async save(p: Persisted): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("save aborted"));
      try {
        for (const key of PERSISTED_KEYS) store.put(p[key], STORAGE_KEYS[key]);
        // Older builds read these: without them they refuse the set.
        for (const k of LEGACY_SYNC_KEYS) store.delete(k);
      } catch (error) {
        // A value that cannot be cloned: abort so nothing of this set is written.
        tx.abort();
        reject(error);
      }
    });
  }
}

/** In-memory store for tests (keys as in IndexedDB); `failNextSave` simulates a full disk. */
export class MemoryStore implements MobileStore {
  data: Record<string, unknown> = {};
  saves = 0;
  failNextSave = false;

  async load(): Promise<Persisted | null> {
    const raw = structuredClone(this.data);
    const { parts, legacy } = partsOf(raw);
    const set = assemble(parts);
    if (legacy) {
      if (this.data[SYNC_KEY] === undefined) {
        this.data[SYNC_KEY] = structuredClone(parts.sync);
      }
      for (const k of LEGACY_SYNC_KEYS) delete this.data[k];
    }
    return set;
  }

  async save(p: Persisted): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("quota exceeded (simulated)");
    }
    // Clone first: a failure leaves the previous set untouched.
    const next = structuredClone(p);
    const data: Record<string, unknown> = {};
    for (const key of PERSISTED_KEYS) data[STORAGE_KEYS[key]] = next[key];
    this.data = data;
    this.saves += 1;
  }
}
