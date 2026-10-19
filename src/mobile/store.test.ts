import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  emptyPersisted,
  LEGACY_SYNC_KEY,
  SYNC_KEY,
  V27_SYNC_KEY,
  V28_SYNC_KEY,
} from "./persisted";
import {
  DB_NAME,
  DB_VERSION,
  InconsistentStoreError,
  IndexedDbStore,
  MemoryStore,
  STORE_NAME,
} from "./store";

const withTask = (title: string) => {
  const p = emptyPersisted();
  p.state.tasks.push({
    id: "t1",
    parentId: null,
    priority: 1,
    subjectId: null,
    sectionId: null,
    title,
    description: "",
    dueDate: null,
    dueTime: null,
    workdirOverride: null,
    completedAt: null,
    position: 1,
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
    deletedAt: null,
  });
  p.outbox["task:t1"] = {
    changed_at: "2026-10-04T10:00:00.000Z",
    purged: false,
  };
  return p;
};

describe("IndexedDbStore", () => {
  it("returns null when nothing was saved, then round-trips the set", async () => {
    const store = new IndexedDbStore(new IDBFactory());
    expect(await store.load()).toBeNull();
    const p = withTask("A");
    await store.save(p);
    expect(await store.load()).toEqual(p);
  });

  it("writes all or nothing: a failing save leaves the previous set", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbStore(factory);
    await store.save(withTask("A"));
    const broken = withTask("B");
    // A function cannot be cloned: the put throws and the transaction aborts.
    (broken.sync as unknown as { bad: () => void }).bad = () => {};
    await expect(store.save(broken)).rejects.toBeDefined();
    const loaded = await new IndexedDbStore(factory).load();
    expect(loaded?.state.tasks[0].title).toBe("A");
  });

  it("rejects an inconsistent set", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => {
        const tx = req.result.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({}, "snapshot");
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    await expect(new IndexedDbStore(factory).load()).rejects.toBeInstanceOf(
      InconsistentStoreError,
    );
  });
});

/** Raw values of some keys of the `kv` store. */
async function rawKeys(
  factory: IDBFactory,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE_NAME, "readonly");
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const get = tx.objectStore(STORE_NAME).get(key);
        get.onsuccess = () => {
          out[key] = get.result;
        };
      }
      tx.oncomplete = () => {
        req.result.close();
        resolve(out);
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Writes raw values, as a build before V2.7 bis did (`sync` under its old key). */
async function writeRaw(
  factory: IDBFactory,
  values: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE_NAME, "readwrite");
      for (const [key, value] of Object.entries(values)) {
        tx.objectStore(STORE_NAME).put(value, key);
      }
      tx.oncomplete = () => {
        req.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/**
 * The loader of the builds before V2.7 bis (src/mobile/store.ts at 807d6b5): five keys read
 * under their own names, a partial set refused.
 */
const OLD_KEYS = ["state", "snapshot", "outbox", "parked", "sync"] as const;
function oldAssemble(parts: Record<string, unknown>): unknown {
  const present = OLD_KEYS.filter((k) => parts[k] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== OLD_KEYS.length) {
    throw new Error(`inconsistent persisted set (present: ${present})`);
  }
  return parts;
}

describe("saved data and older builds (V2.7 bis)", () => {
  it("moves a set saved before V2.7 bis to the new sync key while loading it", async () => {
    const factory = new IDBFactory();
    const old = withTask("A");
    delete old.state.attachments;
    await writeRaw(factory, { ...old });
    const loaded = await new IndexedDbStore(factory).load();
    expect(loaded).toEqual(old);
    const raw = await rawKeys(factory, [LEGACY_SYNC_KEY, SYNC_KEY]);
    expect(raw[LEGACY_SYNC_KEY]).toBeUndefined();
    expect(raw[SYNC_KEY]).toEqual(old.sync);
    // Loaded again: the same set.
    expect(await new IndexedDbStore(factory).load()).toEqual(old);
  });

  it("a set loaded or saved by this build is refused by the loader of older builds", async () => {
    const migrated = new IDBFactory();
    await writeRaw(migrated, { ...withTask("A") });
    await new IndexedDbStore(migrated).load();
    const saved = new IDBFactory();
    await new IndexedDbStore(saved).save(withTask("B"));
    for (const factory of [migrated, saved]) {
      const parts = await rawKeys(factory, OLD_KEYS);
      expect(() => oldAssemble(parts)).toThrow(/inconsistent/);
    }
  });

  it("a save drops the old key even when both are there", async () => {
    const factory = new IDBFactory();
    await writeRaw(factory, { sync: { stale: true } });
    await new IndexedDbStore(factory).save(withTask("A"));
    const raw = await rawKeys(factory, [LEGACY_SYNC_KEY, SYNC_KEY]);
    expect(raw[LEGACY_SYNC_KEY]).toBeUndefined();
    expect(
      (await new IndexedDbStore(factory).load())?.state.tasks[0].title,
    ).toBe("A");
  });

  it("never rewrites an inconsistent set", async () => {
    const factory = new IDBFactory();
    await writeRaw(factory, { snapshot: {}, sync: { kept: true } });
    await expect(new IndexedDbStore(factory).load()).rejects.toBeInstanceOf(
      InconsistentStoreError,
    );
    const raw = await rawKeys(factory, [LEGACY_SYNC_KEY, SYNC_KEY]);
    expect(raw[LEGACY_SYNC_KEY]).toEqual({ kept: true });
    expect(raw[SYNC_KEY]).toBeUndefined();
  });

  it("the memory store follows the same keys", async () => {
    const store = new MemoryStore();
    const old = withTask("A");
    store.data = { ...old };
    expect(await store.load()).toEqual(old);
    expect(Object.keys(store.data).sort()).toEqual(
      ["outbox", "parked", "snapshot", "state", SYNC_KEY].sort(),
    );
    await store.save(withTask("B"));
    expect(() => oldAssemble(store.data)).toThrow(/inconsistent/);
  });

  it("V2.8: moves a set saved by V2.7 bis (`sync.2`) to `sync.3`; the V2.7 bis loader then refuses it", async () => {
    const factory = new IDBFactory();
    const old = withTask("A");
    delete old.state.boardColumns;
    const { sync, ...rest } = old;
    await writeRaw(factory, { ...rest, [V27_SYNC_KEY]: sync });
    const loaded = await new IndexedDbStore(factory).load();
    expect(loaded).toEqual(old);
    const raw = await rawKeys(factory, [V27_SYNC_KEY, SYNC_KEY]);
    expect(raw[V27_SYNC_KEY]).toBeUndefined();
    expect(raw[SYNC_KEY]).toEqual(sync);
    const v27Keys = ["state", "snapshot", "outbox", "parked", V27_SYNC_KEY];
    const parts = await rawKeys(factory, v27Keys);
    const present = v27Keys.filter((k) => parts[k] !== undefined);
    expect(present).toHaveLength(4);

    // The memory store too, and a save drops both older keys.
    const store = new MemoryStore();
    store.data = { ...rest, [V27_SYNC_KEY]: sync, [LEGACY_SYNC_KEY]: { x: 1 } };
    expect(await store.load()).toEqual(old);
    expect(Object.keys(store.data).sort()).toEqual(
      ["outbox", "parked", "snapshot", "state", SYNC_KEY].sort(),
    );
  });

  it("notebook: moves a set saved by V2.8 (`sync.3`) to `sync.4`; the V2.8 loader then refuses it, so it never sends a deletion of the notebook rows it does not know", async () => {
    expect(SYNC_KEY).toBe("sync.4");
    expect(V28_SYNC_KEY).toBe("sync.3");
    const factory = new IDBFactory();
    const old = withTask("A");
    const { sync, ...rest } = old;
    await writeRaw(factory, { ...rest, [V28_SYNC_KEY]: sync });
    const loaded = await new IndexedDbStore(factory).load();
    expect(loaded).toEqual(old);
    const raw = await rawKeys(factory, [V28_SYNC_KEY, SYNC_KEY]);
    expect(raw[V28_SYNC_KEY]).toBeUndefined();
    expect(raw[SYNC_KEY]).toEqual(sync);
    const v28Keys = ["state", "snapshot", "outbox", "parked", V28_SYNC_KEY];
    const parts = await rawKeys(factory, v28Keys);
    expect(v28Keys.filter((k) => parts[k] !== undefined)).toHaveLength(4);

    const store = new MemoryStore();
    store.data = { ...rest, [V28_SYNC_KEY]: sync, [V27_SYNC_KEY]: { x: 1 } };
    expect(await store.load()).toEqual(old);
    await store.save(old);
    expect(Object.keys(store.data).sort()).toEqual(
      ["outbox", "parked", "snapshot", "state", SYNC_KEY].sort(),
    );
  });
});
