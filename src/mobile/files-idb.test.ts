// @vitest-environment node
/**
 * The IndexedDB store of the kept attachment files (`todo-files`, src/mobile/files.ts), on
 * fake-indexeddb (Node: its Blob survives the structured clone, as in a browser).
 */

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { FILES_DB_NAME, FILES_STORE, IndexedDbFileStore } from "./files";
import { DB_NAME, IndexedDbStore } from "./store";

describe("IndexedDbFileStore", () => {
  it("keeps blobs with their hash and size, lists and drops them", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbFileStore(factory);
    expect(await store.get("att-1")).toBeNull();
    await store.put("att-1", {
      blob: new Blob(["abc"], { type: "text/plain" }),
      sha256: "a".repeat(64),
      size: 3,
    });
    await store.put("att-2", {
      blob: new Blob(["d"]),
      sha256: "b".repeat(64),
      size: 1,
    });
    const kept = await store.get("att-1");
    expect(kept?.sha256).toBe("a".repeat(64));
    expect(kept?.size).toBe(3);
    expect(await kept?.blob.text()).toBe("abc");
    expect((await store.ids()).sort()).toEqual(["att-1", "att-2"]);
    await store.delete("att-1");
    expect(await store.ids()).toEqual(["att-2"]);
    // A new page finds them (its own database, apart from the persisted set's).
    expect(await new IndexedDbFileStore(factory).ids()).toEqual(["att-2"]);
  });

  it("lives in its own database: the persisted set's `todo` is never upgraded", async () => {
    const factory = new IDBFactory();
    await new IndexedDbFileStore(factory).put("x", {
      blob: new Blob(["x"]),
      sha256: "c".repeat(64),
      size: 1,
    });
    expect(await new IndexedDbStore(factory).load()).toBeNull();
    const names = (await factory.databases()).map((d) => [d.name, d.version]);
    expect(names).toContainEqual([FILES_DB_NAME, 1]);
    expect(names).toContainEqual([DB_NAME, 1]);
    const open = factory.open(FILES_DB_NAME);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    expect([...db.objectStoreNames]).toEqual([FILES_STORE]);
    db.close();
  });

  it("opens again when its connection was closed under it", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbFileStore(factory);
    await store.put("att-1", {
      blob: new Blob(["a"]),
      sha256: "a".repeat(64),
      size: 1,
    });
    // The browser dropped the connection (Safari after a while in the background).
    const db = await (store as unknown as { db: Promise<IDBDatabase> }).db;
    db.close();
    expect((await store.get("att-1"))?.size).toBe(1);
    expect(await store.ids()).toEqual(["att-1"]);
  });

  it("fails cleanly without IndexedDB", async () => {
    const store = new IndexedDbFileStore();
    const saved = globalThis.indexedDB;
    // @ts-expect-error: a page without IndexedDB (private mode of some browsers)
    delete globalThis.indexedDB;
    try {
      await expect(store.ids()).rejects.toThrow("indexedDB unavailable");
    } finally {
      if (saved) globalThis.indexedDB = saved;
    }
  });
});
