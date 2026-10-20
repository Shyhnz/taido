import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EPOCH_STAMP,
  SETTING_INBOX_POSITION,
  stampPlusOneMs,
} from "../lib/sync-proto";
import {
  createMobileBackend,
  MobileBackend,
  RETENTION_MS,
  randomUuid,
} from "./backend";
import { MemoryFileStore } from "./files";
import { emptyPersisted, SYNC_KEY, V27_SYNC_KEY } from "./persisted";
import { MemoryStore } from "./store";
import {
  attachment,
  boardColumn,
  Clock,
  link,
  makePhone,
  noteAttachment,
  noteGroup,
  notePage,
  relation,
  subject,
  task,
  timeSegment,
} from "./test/helpers";

afterEach(() => {
  vi.useRealTimers();
});

const keys = (o: object) => Object.keys(o).sort();

describe("randomUuid", () => {
  it("builds a v4 UUID without crypto.randomUUID (plain http on the LAN)", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      const a = randomUuid();
      expect(a).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(randomUuid()).not.toBe(a);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("snapshot diff outbox", () => {
  it("queues creations, edits, completion and soft deletes with increasing stamps", async () => {
    const { backend, clock } = makePhone();
    const s = await backend.commands.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const t = await backend.commands.createTask({
      title: "Appeler Paul",
      description: null,
      subjectId: s.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    expect(keys(backend.outbox)).toEqual(
      [`subject:${s.id}`, `task:${t.id}`].sort(),
    );
    expect(backend.outbox[`task:${t.id}`].purged).toBe(false);
    const created = backend.outbox[`task:${t.id}`].changed_at;

    clock.advance(1000);
    await backend.commands.updateTask({
      id: t.id,
      title: "Appeler Paul demain",
      description: "note",
    });
    const edited = backend.outbox[`task:${t.id}`].changed_at;
    expect(edited > created).toBe(true);
    expect(JSON.parse(backend.snapshot[`task:${t.id}`].json).description).toBe(
      "note",
    );

    clock.advance(1000);
    await backend.commands.setTaskCompleted({ id: t.id, completed: true });
    const completed = backend.outbox[`task:${t.id}`].changed_at;
    expect(completed > edited).toBe(true);
    expect(
      JSON.parse(backend.snapshot[`task:${t.id}`].json).completed_at,
    ).not.toBeNull();

    clock.advance(1000);
    await backend.commands.deleteTask(t.id);
    expect(
      JSON.parse(backend.snapshot[`task:${t.id}`].json).deleted_at,
    ).not.toBeNull();
    expect(backend.outbox[`task:${t.id}`].purged).toBe(false);
  });

  it("turns a purge into a tombstone", async () => {
    const { backend, clock } = makePhone();
    const t = await backend.commands.createTask({
      title: "Vieux",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await backend.commands.deleteTask(t.id);
    clock.advance(RETENTION_MS + 1000);
    expect(backend.purge()).toBe(1);
    expect(backend.outbox[`task:${t.id}`].purged).toBe(true);
    expect(backend.snapshot[`task:${t.id}`]).toBeUndefined();
  });

  it("ignores local-only fields and the journal", async () => {
    const { backend } = makePhone();
    const t = await backend.commands.createTask({
      title: "A",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    for (const k of Object.keys(backend.outbox)) delete backend.outbox[k];
    await backend.commands.addNote({ taskId: t.id, text: "journal" });
    backend.state.tasks[0].workdirOverride = "/tmp";
    backend.emitDataChanged(["tasks"]);
    expect(backend.outbox).toEqual({});
  });

  it("stamps an edit of a row pulled at a future stamp with that stamp + 1 ms", async () => {
    const { backend } = makePhone();
    const future = "2030-01-01T00:00:00.000Z";
    backend.applyPulled([task("t1", future)]);
    expect(backend.outbox).toEqual({});
    await backend.commands.updateTask({
      id: "t1",
      title: "edited",
      description: null,
    });
    expect(backend.outbox["task:t1"].changed_at).toBe(stampPlusOneMs(future));
    // The device's next stamp never goes back either.
    const t = await backend.commands.createTask({
      title: "B",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    expect(backend.outbox[`task:${t.id}`].changed_at > future).toBe(true);
  });

  it("queues exactly one task for a move", async () => {
    const { backend } = makePhone();
    const ids: string[] = [];
    for (const title of ["A", "B", "C", "D"]) {
      const t = await backend.commands.createTask({
        title,
        description: null,
        subjectId: null,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
      ids.push(t.id);
    }
    for (const k of Object.keys(backend.outbox)) delete backend.outbox[k];
    await backend.commands.moveTask({
      id: ids[3],
      subjectId: null,
      sectionId: null,
      index: 1,
    });
    expect(Object.keys(backend.outbox)).toEqual([`task:${ids[3]}`]);
  });

  it("a copy of a task in a Kanban column starts without column, like the core", async () => {
    const { backend } = makePhone();
    backend.applyPulled([
      task("t", "2026-10-01T00:00:00.000Z", { board_column_id: "col-inbox-2" }),
    ]);
    const copy = await backend.commands.duplicateTask("t");
    const rec = backend.state.tasks.find((x) => x.id === copy.id);
    expect(rec?.boardColumnId ?? null).toBeNull();
    expect(JSON.parse(backend.snapshot[`task:${copy.id}`].json)).toMatchObject({
      board_column_id: null,
    });
    // The original keeps its column.
    expect(JSON.parse(backend.snapshot["task:t"].json)).toMatchObject({
      board_column_id: "col-inbox-2",
    });
  });

  it("uses globally unique ids", async () => {
    const { backend } = makePhone();
    const t = await backend.commands.createTask({
      title: "A",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("deletion guard", () => {
  async function phoneWith(n: number) {
    const phone = makePhone();
    for (let i = 0; i < n; i += 1) {
      await phone.backend.commands.createTask({
        title: `T${i}`,
        description: null,
        subjectId: null,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
    }
    for (const k of Object.keys(phone.backend.outbox)) {
      delete phone.backend.outbox[k];
    }
    return phone;
  }

  it("holds 30 vanished live rows, then confirms them", async () => {
    const { backend } = await phoneWith(40);
    const events: string[] = [];
    await backend.events.syncChanged.listen((e) =>
      events.push(e.payload.status.errorKind ?? "none"),
    );
    const gone = backend.state.tasks.slice(0, 30).map((t) => t.id);
    backend.state.tasks = backend.state.tasks.slice(30);
    backend.emitDataChanged(["tasks"]);
    expect(backend.outbox).toEqual({});
    expect(backend.heldDeletions.size).toBe(30);
    expect(backend.syncData.heldDeletions).toEqual([]);
    expect(backend.persisted().sync.heldDeletions).toHaveLength(30);
    expect(events).toContain("none"); // unlinked: the state stays « unlinked »

    backend.confirmHeldDeletions();
    expect(backend.heldDeletions.size).toBe(0);
    for (const id of gone) {
      expect(backend.outbox[`task:${id}`].purged).toBe(true);
      expect(backend.snapshot[`task:${id}`]).toBeUndefined();
    }
  });

  it("restores the held rows from the snapshot", async () => {
    const { backend } = await phoneWith(40);
    const before = backend.state.tasks.map((t) => t.title).sort();
    backend.state.tasks = backend.state.tasks.slice(30);
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(30);
    backend.restoreHeldDeletions();
    expect(backend.heldDeletions.size).toBe(0);
    expect(backend.state.tasks.map((t) => t.title).sort()).toEqual(before);
    expect(backend.outbox).toEqual({});
  });

  it("lets a few deletions through", async () => {
    const { backend } = await phoneWith(40);
    backend.state.tasks = backend.state.tasks.slice(4);
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(0);
    expect(Object.values(backend.outbox).every((e) => e.purged)).toBe(true);
    expect(Object.keys(backend.outbox)).toHaveLength(4);
  });

  it("holds 5 rows out of 10 (more than 20 %)", async () => {
    const { backend } = await phoneWith(10);
    backend.state.tasks = backend.state.tasks.slice(5);
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(5);
  });
});

describe("persistence", () => {
  it("round-trips through the store", async () => {
    const store = new MemoryStore();
    const clock = new Clock();
    const a = await createMobileBackend({ store, now: clock.now });
    const s = await a.commands.createSubject({
      name: "Perso",
      color: null,
      rootPath: null,
      parentId: null,
    });
    await a.commands.createTask({
      title: "Courses",
      description: "lait",
      subjectId: s.id,
      sectionId: null,
      dueDate: "2026-10-05",
      dueTime: null,
    });
    await a.commands.updateSettings({
      theme: "dark",
      colorTheme: "plum",
      syncTheme: false,
      panelWidth: null,
      showCompleted: null,
      editor: null,
      claudePath: null,
      summarizeSessions: null,
      notifications: null,
      tutorial: null,
      chronoCountsWaiting: null,
      defaultAgent: null,
      codexPath: null,
      agentChosen: null,
      voiceSpaceHold: null,
      language: null,
    });
    await a.saveNow();

    const b = await createMobileBackend({ store, now: clock.now });
    expect(b.state.subjects.map((x) => x.name)).toEqual(["Perso"]);
    expect(b.state.tasks[0].description).toBe("lait");
    expect(b.state.settings.theme).toBe("dark");
    expect(b.state.settings.colorTheme).toBe("plum");
    expect(b.state.settings.syncTheme).toBe(false);
    expect(b.outbox).toEqual(a.outbox);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.syncData.lastStamp).toBe(a.syncData.lastStamp);
  });

  it("debounces saves after a change", async () => {
    vi.useFakeTimers();
    const { backend, store } = makePhone();
    await backend.commands.createTask({
      title: "A",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    expect(store.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(store.saves).toBe(1);
  });

  it("keeps the previous set when a save fails, and reports it", async () => {
    const store = new MemoryStore();
    const onStorageError = vi.fn();
    const a = await createMobileBackend({ store, onStorageError });
    await a.commands.createTask({
      title: "Premier",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await a.saveNow();
    await a.commands.createTask({
      title: "Second",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    store.failNextSave = true;
    await a.saveNow();
    expect(onStorageError).toHaveBeenCalledTimes(1);
    const b = await createMobileBackend({ store });
    expect(b.state.tasks.map((t) => t.title)).toEqual(["Premier"]);
  });

  it("starts empty, without saving nor syncing, on an inconsistent set", async () => {
    const store = new MemoryStore();
    store.data = { state: { subjects: [], sections: [], tasks: [] } };
    const backend = await createMobileBackend({ store });
    expect(backend.storageBroken).toBe(true);
    await backend.commands.createTask({
      title: "A",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await backend.saveNow();
    expect(store.saves).toBe(0);
    await expect(
      backend.commands.syncLogin({
        serverUrl: "https://todo.test",
        email: "user@exemple.fr",
        password: "x",
      }),
    ).rejects.toMatchObject({ kind: "internal" });
  });

  it("purges old soft-deleted rows at startup when unlinked", async () => {
    const store = new MemoryStore();
    const clock = new Clock();
    const a = await createMobileBackend({ store, now: clock.now });
    const t = await a.commands.createTask({
      title: "A",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await a.commands.deleteTask(t.id);
    await a.saveNow();
    clock.advance(RETENTION_MS + 1);
    const b = await createMobileBackend({ store, now: clock.now });
    expect(b.state.tasks).toEqual([]);
    expect(b.outbox[`task:${t.id}`].purged).toBe(true);
  });
});

describe("shared settings (inbox position)", () => {
  const INBOX_KEY = `setting:${SETTING_INBOX_POSITION}`;

  const project = (backend: ReturnType<typeof makePhone>["backend"]) =>
    backend.commands.createSubject({
      name: "P",
      color: null,
      rootPath: null,
      parentId: null,
    });

  it("queues the inbox position when « Sans projet » moves", async () => {
    const { backend } = makePhone();
    const p = await project(backend);
    for (const k of Object.keys(backend.outbox)) delete backend.outbox[k];
    await backend.commands.reorderInbox(0);
    expect(Object.keys(backend.outbox)).toEqual([INBOX_KEY]);
    expect(backend.outbox[INBOX_KEY].purged).toBe(false);
    expect(JSON.parse(backend.snapshot[INBOX_KEY].json)).toEqual({ value: 0 });
    expect(await backend.commands.getInboxIndex()).toBe(0);
    // Moving the project past it moves the project only.
    delete backend.outbox[INBOX_KEY];
    await backend.commands.reorderSubject({ id: p.id, index: 0 });
    expect(Object.keys(backend.outbox)).toEqual([`subject:${p.id}`]);
    expect(await backend.commands.getInboxIndex()).toBe(1);
  });

  it("queues nothing while « Sans projet » was never moved", async () => {
    const { backend } = makePhone();
    const a = await project(backend);
    const b = await project(backend);
    await backend.commands.reorderSubject({ id: b.id, index: 0 });
    expect(Object.keys(backend.outbox).sort()).toEqual(
      [`subject:${a.id}`, `subject:${b.id}`].sort(),
    );
    expect(backend.state.syncedSettings).toEqual({});
  });

  it("round-trips the shared settings through the store", async () => {
    const store = new MemoryStore();
    const a = await createMobileBackend({ store });
    await project(a);
    await a.commands.reorderInbox(0);
    await a.saveNow();
    const b = await createMobileBackend({ store });
    expect(b.state.syncedSettings).toEqual({ [SETTING_INBOX_POSITION]: 0 });
    expect(await b.commands.getInboxIndex()).toBe(0);
    expect(b.snapshot[INBOX_KEY]).toEqual(a.snapshot[INBOX_KEY]);
  });

  it("loads a set saved before the shared settings existed", async () => {
    const store = new MemoryStore();
    const old = emptyPersisted();
    delete old.state.syncedSettings;
    old.state.subjects.push({
      id: "p",
      name: "P",
      color: "teal",
      rootPath: null,
      parentId: null,
      position: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    });
    await store.save(old);
    const backend = await createMobileBackend({ store });
    expect(backend.storageBroken).toBe(false);
    expect(backend.state.syncedSettings).toEqual({});
    expect(await backend.commands.getInboxIndex()).toBe(1);
    await backend.commands.reorderInbox(0);
    await backend.saveNow();
    expect(
      (store.data.state as { syncedSettings?: unknown }).syncedSettings,
    ).toEqual({ [SETTING_INBOX_POSITION]: 0 });
  });

  it("loads a set saved by an older build: no account, no group nor column, nothing to send", async () => {
    const store = new MemoryStore();
    const old = emptyPersisted();
    const at = "2026-10-01T00:00:00.000Z";
    // Linked to the server, before the phone read accounts.
    old.sync = {
      ...old.sync,
      serverUrl: "https://todo.test",
      token: "token-old",
      deviceId: "device-old",
      serverEpoch: "epoch-1",
      cursor: 7,
      lastStamp: at,
    };
    delete old.sync.account;
    old.state.subjects.push({
      id: "p",
      name: "P",
      color: "teal",
      rootPath: null,
      parentId: null,
      position: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    });
    old.state.tasks.push({
      id: "t",
      parentId: null,
      priority: 1,
      subjectId: "p",
      sectionId: null,
      title: "T",
      description: "",
      dueDate: null,
      dueTime: null,
      workdirOverride: null,
      completedAt: null,
      position: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    });
    // What that version pushed: `is_group: false`, `board_column_id: null`.
    old.snapshot["subject:p"] = {
      stamp: at,
      json: JSON.stringify({
        name: "P",
        color: "teal",
        parent_id: null,
        position: 1,
        created_at: at,
        deleted_at: null,
        is_group: false,
      }),
    };
    old.snapshot["task:t"] = {
      stamp: at,
      json: JSON.stringify({
        subject_id: "p",
        section_id: null,
        parent_id: null,
        title: "T",
        description: "",
        due_date: null,
        due_time: null,
        priority: 1,
        completed_at: null,
        position: 1,
        created_at: at,
        deleted_at: null,
        board_column_id: null,
      }),
    };
    await store.save(old);
    const backend = await createMobileBackend({ store });
    expect(backend.storageBroken).toBe(false);
    expect((await backend.commands.syncStatus()).state).not.toBe("unlinked");
    expect(await backend.commands.syncAccount()).toBeNull();
    expect((await backend.commands.listSubjects())[0].isGroup).toBe(false);
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("leaves settings out of the deletion guard's ratio", async () => {
    const { backend } = makePhone();
    for (let i = 0; i < 10; i += 1) {
      await backend.commands.createTask({
        title: `T${i}`,
        description: null,
        subjectId: null,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      });
    }
    // Many settings (unknown keys are allowed) would dilute the ratio if they counted.
    for (let i = 0; i < 100; i += 1) {
      backend.state.syncedSettings[`future_${i}`] = i;
    }
    backend.emitDataChanged(["subjects"]);
    for (const k of Object.keys(backend.outbox)) delete backend.outbox[k];
    backend.state.tasks = backend.state.tasks.slice(5);
    backend.emitDataChanged(["tasks"]);
    // 5 of 10 tasks: held (settings do not count in the total).
    expect(backend.heldDeletions.size).toBe(5);
    expect(backend.outbox).toEqual({});
  });
});

describe("attachments", () => {
  const AT = "2026-10-01T00:00:00.000Z";

  it("round-trips the attachments and their file state through the store", async () => {
    const store = new MemoryStore();
    const fileStore = new MemoryFileStore();
    const a = await createMobileBackend({ store, fileStore });
    const t = await a.commands.createTask({
      title: "Devis",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await a.files.add(t.id, [new File(["abc"], "devis.pdf")]);
    a.applyPulled([
      task("mac-task", AT),
      attachment("mac-att", "mac-task", AT),
    ]);
    await a.saveNow();
    const b = await createMobileBackend({ store, fileStore });
    expect(b.links.attachments).toEqual(a.links.attachments);
    expect(
      b.links.attachments.map((x) => [x.fileName, x.file, x.sha256 ?? null]),
    ).toEqual([
      [
        "devis.pdf",
        "local",
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ],
      ["mac-att.pdf", "missing", null],
    ]);
    b.diff();
    expect(b.outbox).toEqual(a.outbox);
  });

  it("a linked set saved by an older build pulls everything again once, for the attachments it skipped", async () => {
    const linked = (attachments: boolean) => {
      const old = emptyPersisted();
      old.sync = {
        ...old.sync,
        serverUrl: "https://todo.test",
        token: "token-old",
        deviceId: "device-old",
        serverEpoch: "epoch-1",
        cursor: 7,
      };
      if (!attachments) delete old.state.attachments;
      return old;
    };
    const before = new MemoryStore();
    await before.save(linked(false));
    expect((await createMobileBackend({ store: before })).syncData.cursor).toBe(
      0,
    );
    const after = new MemoryStore();
    await after.save(linked(true));
    expect((await createMobileBackend({ store: after })).syncData.cursor).toBe(
      7,
    );
  });

  it("drops the kept files of attachments that are gone at load", async () => {
    const store = new MemoryStore();
    const fileStore = new MemoryFileStore();
    await fileStore.put("orphan", {
      blob: new Blob(["x"]),
      sha256: "0".repeat(64),
      size: 1,
    });
    const backend = await createMobileBackend({ store, fileStore });
    await backend.files.whenIdle();
    expect(await fileStore.ids()).toEqual([]);
  });

  it("purging a task purges its attachments, sent as tombstones", async () => {
    const store = new MemoryStore();
    const clock = new Clock();
    const fileStore = new MemoryFileStore();
    const a = await createMobileBackend({ store, fileStore, now: clock.now });
    const t = await a.commands.createTask({
      title: "A",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await a.files.add(t.id, [new File(["abc"], "a.txt")]);
    const [att] = a.links.attachments;
    await a.commands.deleteTask(t.id);
    // In the trash, the file stays (the task can come back).
    await a.files.whenIdle();
    expect(await fileStore.get(att.id)).not.toBeNull();
    await a.saveNow();
    clock.advance(RETENTION_MS + 1);
    const b = await createMobileBackend({ store, fileStore, now: clock.now });
    await b.files.whenIdle();
    expect(b.links.attachments).toEqual([]);
    expect(b.outbox[`attachment:${att.id}`].purged).toBe(true);
    expect(await fileStore.get(att.id)).toBeNull();
  });

  it("the deletion guard holds vanished attachments with their tasks and restores them", async () => {
    const { backend } = makePhone();
    const changes = [];
    for (let i = 0; i < 30; i += 1) {
      changes.push(task(`t${i}`, AT), attachment(`a${i}`, `t${i}`, AT));
    }
    backend.applyPulled(changes);
    backend.state.tasks = [];
    backend.links.attachments = [];
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(60);
    expect(backend.outbox).toEqual({});
    backend.restoreHeldDeletions();
    expect(backend.links.attachments.map((a) => a.id).sort()).toEqual(
      changes
        .filter((c) => c.entity === "attachment")
        .map((c) => c.id)
        .sort(),
    );
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("the deletion guard holds attachments that vanish while their tasks stay", async () => {
    const { backend } = makePhone();
    const changes = [];
    for (let i = 0; i < 10; i += 1) {
      changes.push(task(`t${i}`, AT), attachment(`a${i}`, `t${i}`, AT));
    }
    backend.applyPulled(changes);
    // What an older web app does to the attachments it does not know.
    backend.links.attachments = [];
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(10);
    expect(backend.outbox).toEqual({});
  });

  it("a wipe is held however many attachments go with it", async () => {
    const { backend } = makePhone();
    const changes = [];
    for (let i = 0; i < 5; i += 1) {
      changes.push(task(`t${i}`, AT));
      for (let j = 0; j < 5; j += 1) {
        changes.push(attachment(`a${i}-${j}`, `t${i}`, AT));
      }
    }
    backend.applyPulled(changes);
    backend.state.tasks = [];
    backend.links.attachments = [];
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(30);
    expect(backend.outbox).toEqual({});
  });

  it("lets the deletion of a few attachments through", async () => {
    const { backend } = makePhone();
    const changes = [];
    for (let i = 0; i < 10; i += 1) {
      changes.push(task(`t${i}`, AT), attachment(`a${i}`, `t${i}`, AT));
    }
    backend.applyPulled(changes);
    backend.links.attachments = backend.links.attachments.filter(
      (a) => a.id !== "a0" && a.id !== "a1",
    );
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(0);
    expect(Object.keys(backend.outbox).sort()).toEqual([
      "attachment:a0",
      "attachment:a1",
    ]);
    expect(Object.values(backend.outbox).every((e) => e.purged)).toBe(true);
  });

  it("attachments purged with their task are that task's deletion, not held", async () => {
    const { backend } = makePhone();
    const changes = [task("t0", AT), task("t1", AT)];
    for (let i = 0; i < 6; i += 1) {
      changes.push(attachment(`a${i}`, "t0", AT));
    }
    backend.applyPulled(changes);
    backend.state.tasks = backend.state.tasks.filter((t) => t.id !== "t0");
    backend.links.attachments = [];
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(0);
    expect(
      Object.entries(backend.outbox)
        .filter(([, e]) => e.purged)
        .map(([k]) => k)
        .sort(),
    ).toEqual(
      ["a0", "a1", "a2", "a3", "a4", "a5", "t0"]
        .map((id) => (id === "t0" ? "task:t0" : `attachment:${id}`))
        .sort(),
    );
  });
});

describe("a set written by an older build over newer data", () => {
  /**
   * A linked phone whose file is kept here only (the account was full), then what an older
   * web app leaves when it saves: no `state.attachments`, and the deletion of every
   * attachment queued by its diff.
   */
  async function overwrittenByAnOldBuild() {
    const phone = makePhone();
    await link(phone);
    const t = await phone.backend.commands.createTask({
      title: "Devis",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    phone.server.quotaBytes = 0;
    await phone.backend.files.add(t.id, [new File(["abc"], "devis.pdf")]);
    await phone.backend.engine.syncNow();
    await phone.backend.files.whenIdle();
    const [att] = phone.backend.links.attachments;
    expect(att.file).toBe("quota_exceeded");
    expect(phone.server.files.get(att.id)?.complete).not.toBe(true);
    const old = phone.backend.persisted();
    delete old.state.attachments;
    delete old.snapshot[`attachment:${att.id}`];
    old.outbox[`attachment:${att.id}`] = {
      changed_at: "2026-10-04T11:00:00.000Z",
      purged: true,
    };
    old.sync.heldDeletions = [`attachment:${att.id}`];
    phone.server.quotaBytes = 1_000_000;
    return { phone, old, att, t };
  }

  it("sends no attachment deletion and drops no kept file before its first sync", async () => {
    const { phone, old, att } = await overwrittenByAnOldBuild();
    const again = makePhone(phone.server, {
      persisted: old,
      files: phone.files,
    });
    const b = again.backend;
    expect(
      Object.keys(b.outbox).filter((k) => k.startsWith("attachment:")),
    ).toEqual([]);
    expect(
      Object.keys(b.snapshot).filter((k) => k.startsWith("attachment:")),
    ).toEqual([]);
    expect([...b.heldDeletions]).toEqual([]);
    expect(b.syncData.cursor).toBe(0);
    expect(b.syncData.filesRecovery).toBe(true);
    b.diff();
    expect(Object.keys(b.outbox)).toEqual([]);
    await b.files.sweep();
    await b.files.whenIdle();
    expect(await again.files.get(att.id)).not.toBeNull();
    // Reloaded before any sync: still waiting, still kept.
    await b.saveNow();
    const reloaded = makePhone(phone.server, {
      persisted: await again.store.load(),
      files: phone.files,
    });
    expect(reloaded.backend.syncData.filesRecovery).toBe(true);
    await reloaded.backend.files.sweep();
    await reloaded.backend.files.whenIdle();
    expect(await again.files.get(att.id)).not.toBeNull();
  });

  it("its first sync brings the attachments back and sends the copies kept here", async () => {
    const { phone, old, att, t } = await overwrittenByAnOldBuild();
    const again = makePhone(phone.server, {
      persisted: old,
      files: phone.files,
    });
    await again.backend.engine.syncNow();
    await again.backend.files.whenIdle();
    expect(again.backend.syncData.filesRecovery).toBeUndefined();
    const row = phone.server.get(`attachment:${att.id}`);
    expect(row?.data).toMatchObject({ task_id: t.id, deleted_at: null });
    expect(phone.server.files.get(att.id)?.complete).toBe(true);
    expect(again.backend.links.attachments.map((a) => [a.id, a.file])).toEqual([
      [att.id, "sent"],
    ]);
    // Sent: the copy kept here goes, as for any sent file.
    expect(await again.files.get(att.id)).toBeNull();
    expect(
      phone.server.requests.flatMap((r) =>
        r.changes.filter((c) => c.entity === "attachment" && c.data === null),
      ),
    ).toEqual([]);
  });
});

describe("Kanban columns, time segments and relations", () => {
  const T0 = "2026-10-01T00:00:00.000Z";
  const AT = "2026-10-01T00:30:00.000Z";

  /** A pulled project with a column, two tasks, a segment and a relation. */
  function pulledPhone() {
    const phone = makePhone();
    phone.backend.applyPulled([
      subject("p", T0),
      boardColumn("col-p-1", "p", T0, { name: "En cours", position: 1 }),
      task("a", T0, { subject_id: "p", board_column_id: "col-p-1" }),
      task("b", T0, { subject_id: "p" }),
      timeSegment("seg-a", "a", T0, { ended_at: AT }),
      timeSegment("seg-run", "b", T0),
      relation("rel-ab", "a", "b", T0),
    ]);
    return phone;
  }

  it("round-trips them through the store", async () => {
    const { backend: src } = pulledPhone();
    await src.commands.addManualTime({ taskId: "a", minutes: 5, note: "x" });
    const store = new MemoryStore();
    await store.save(src.persisted());
    const b = await createMobileBackend({ store });
    expect(b.board.columns).toEqual(src.board.columns);
    expect(b.chrono.segments).toEqual(src.chrono.segments);
    expect(b.links.relations).toEqual(src.links.relations);
    const manual = b.chrono.segments.find((x) => x.source === "manual");
    expect(manual?.createdAt).toBe(manual?.endedAt);
    b.diff();
    expect(b.outbox).toEqual(src.outbox);
    expect(Object.keys(b.outbox)).toEqual([`time_segment:${manual?.id}`]);
  });

  it("a linked set saved by an older build pulls everything again once, and drops what it kept under the new keys", async () => {
    const old = emptyPersisted();
    old.sync = {
      ...old.sync,
      serverUrl: "https://todo.test",
      token: "token-old",
      deviceId: "device-old",
      serverEpoch: "epoch-1",
      cursor: 7,
      lastSyncAt: AT,
      pulledOnce: true,
      heldDeletions: ["task:x", "relation:r"],
    };
    delete old.state.boardColumns;
    delete old.state.timeSegments;
    delete old.state.relations;
    old.snapshot["time_segment:s"] = { json: "{}", stamp: AT };
    old.outbox["board_column:c"] = { changed_at: AT, purged: true };
    old.outbox["task:x"] = { changed_at: AT, purged: false };
    const store = new MemoryStore();
    // Saved by `sync` under its key.
    store.data = {
      state: old.state,
      snapshot: old.snapshot,
      outbox: old.outbox,
      parked: old.parked,
      [V27_SYNC_KEY]: old.sync,
    };
    const backend = await createMobileBackend({ store });
    expect(backend.storageBroken).toBe(false);
    expect(backend.syncData.cursor).toBe(0);
    expect(backend.syncData.pulledOnce).toBeUndefined();
    expect(backend.snapshot).toEqual({});
    expect(keys(backend.outbox)).toEqual(["task:x"]);
    expect([...backend.heldDeletions]).toEqual(["task:x"]);
    // Linked, never pulled since: no default column yet.
    expect((await backend.commands.getBoard(null)).columns).toEqual([]);
    await backend.saveNow();
    expect(keys(store.data)).toEqual(
      keys({ state: 1, snapshot: 1, outbox: 1, parked: 1, [SYNC_KEY]: 1 }),
    );

    // Unlinked, the cursor stays and the board is made at once.
    const unlinked = emptyPersisted();
    delete unlinked.state.boardColumns;
    unlinked.sync.cursor = 0;
    const local = new MobileBackend({
      store: new MemoryStore(),
      persisted: unlinked,
    });
    expect((await local.commands.getBoard(null)).columns).toHaveLength(4);
  });

  it("an unlinked phone makes the defaults at once, with fixed ids, queued at the epoch stamp", async () => {
    const { backend } = makePhone();
    const board = await backend.commands.getBoard(null);
    expect(board.columns.map((c) => c.id)).toEqual(
      [0, 1, 2, 3].map((i) => `col-inbox-${i}`),
    );
    for (const c of board.columns) {
      expect(backend.outbox[`board_column:${c.id}`]).toEqual({
        changed_at: EPOCH_STAMP,
        purged: false,
      });
      expect(backend.snapshot[`board_column:${c.id}`].stamp).toBe(EPOCH_STAMP);
    }
    // A later rename is a real edit, stamped after.
    await backend.commands.renameBoardColumn({
      id: "col-inbox-1",
      name: "Chez moi",
    });
    expect(
      backend.outbox["board_column:col-inbox-1"].changed_at > EPOCH_STAMP,
    ).toBe(true);
  });

  it("review point 5: purging a task purges its segments and relations (either side), a project its columns, as tombstones", async () => {
    const { backend, clock } = pulledPhone();
    await backend.commands.deleteTask("b");
    clock.advance(RETENTION_MS + 1);
    backend.purge();
    expect(backend.chrono.segments.map((x) => x.id)).toEqual(["seg-a"]);
    expect(backend.links.relations).toEqual([]);
    expect(backend.heldDeletions.size).toBe(0);
    for (const k of ["task:b", "time_segment:seg-run", "relation:rel-ab"]) {
      expect(backend.outbox[k]?.purged).toBe(true);
    }
    await backend.commands.deleteSubject("p");
    clock.advance(RETENTION_MS + 1);
    backend.purge();
    expect(backend.board.columns).toEqual([]);
    for (const k of ["task:a", "time_segment:seg-a", "board_column:col-p-1"]) {
      expect(backend.outbox[k]?.purged).toBe(true);
    }
  });

  it("the deletion guard counts time segments on their own, and restores them", () => {
    const { backend } = makePhone();
    const changes = [task("t", AT)];
    for (let i = 0; i < 6; i += 1) {
      changes.push(timeSegment(`s${i}`, "t", AT, { ended_at: AT }));
    }
    changes.push(timeSegment("keep", "t", AT, { ended_at: AT }));
    backend.applyPulled(changes);
    backend.chrono.segments = backend.chrono.segments.filter(
      (x) => x.id === "keep",
    );
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(6);
    expect(backend.outbox).toEqual({});
    backend.restoreHeldDeletions();
    expect(backend.chrono.segments.map((x) => x.id).sort()).toEqual(
      ["keep", "s0", "s1", "s2", "s3", "s4", "s5"].sort(),
    );
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("the deletion guard counts columns and relations with the projects and tasks", () => {
    const { backend } = makePhone();
    const changes = [subject("p", AT), task("a", AT), task("b", AT)];
    for (let i = 0; i < 4; i += 1) {
      changes.push(boardColumn(`c${i}`, "p", AT, { position: i }));
    }
    changes.push(relation("r", "a", "b", AT));
    backend.applyPulled(changes);
    // 4 columns and a relation vanish, their project and tasks still here: 5 of 8 rows.
    backend.board.columns = [];
    backend.links.relations = [];
    backend.emitDataChanged(["tasks"]);
    expect(backend.heldDeletions.size).toBe(5);
    backend.restoreHeldDeletions();
    expect(backend.board.columns).toHaveLength(4);
    expect(backend.links.relations).toHaveLength(1);
  });
});

describe("the project notebook", () => {
  const AT = "2026-10-01T00:00:00.000Z";

  const project = async (backend: MobileBackend, name = "Globex") =>
    (
      await backend.commands.createSubject({
        name,
        color: null,
        rootPath: null,
        parentId: null,
      })
    ).id;

  const wire = (backend: MobileBackend, key: string) =>
    JSON.parse(backend.snapshot[key].json) as Record<string, unknown>;

  it("queues a group and a page, in the server's field order, and nothing for the same text", async () => {
    const { backend, clock } = makePhone();
    const c = backend.commands;
    const s = await project(backend);
    const g = await c.createNoteGroup({ subjectId: s, name: "Décisions" });
    const p = await c.createNotePage({
      subjectId: s,
      groupId: g.id,
      title: "Style des mails",
      body: "==x==",
      kind: "page",
      sourceTaskId: null,
    });
    expect(keys(backend.outbox)).toEqual(
      [`subject:${s}`, `note_group:${g.id}`, `note_page:${p.id}`].sort(),
    );
    expect(Object.keys(wire(backend, `note_page:${p.id}`))).toEqual([
      "subject_id",
      "group_id",
      "kind",
      "title",
      "body",
      "source_task_id",
      "pinned_at",
      "position",
      "created_at",
      "deleted_at",
    ]);
    expect(Object.keys(wire(backend, `note_group:${g.id}`))).toEqual([
      "subject_id",
      "name",
      "position",
      "created_at",
    ]);
    const before = structuredClone(backend.outbox[`note_page:${p.id}`]);
    clock.advance(1000);
    await c.updateNotePage({
      id: p.id,
      title: "Style des mails",
      body: "==x==",
    });
    expect(backend.outbox[`note_page:${p.id}`]).toEqual(before);
    clock.advance(1000);
    await c.updateNotePage({ id: p.id, title: null, body: "==y==" });
    expect(
      backend.outbox[`note_page:${p.id}`].changed_at > before.changed_at,
    ).toBe(true);
    expect(wire(backend, `note_page:${p.id}`).body).toBe("==y==");
  });

  it("pinning, moving and deleting a page are one edit of its row; a group goes as a tombstone with its pages edited", async () => {
    const { backend } = makePhone();
    const c = backend.commands;
    const s = await project(backend);
    const g = await c.createNoteGroup({ subjectId: s, name: "G" });
    const p = await c.createNotePage({
      subjectId: s,
      groupId: g.id,
      title: "P",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    backend.outbox = {};
    await c.moveNotePage({ id: p.id, target: "pinned", index: null });
    expect(keys(backend.outbox)).toEqual([`note_page:${p.id}`]);
    expect(wire(backend, `note_page:${p.id}`).pinned_at).not.toBeNull();
    backend.outbox = {};
    await c.deleteNoteGroup(g.id);
    expect(backend.outbox[`note_group:${g.id}`]).toMatchObject({
      purged: true,
    });
    expect(wire(backend, `note_page:${p.id}`).group_id).toBeNull();
    expect(backend.outbox[`note_page:${p.id}`]).toMatchObject({
      purged: false,
    });
    backend.outbox = {};
    await c.deleteNotePage(p.id);
    expect(wire(backend, `note_page:${p.id}`).deleted_at).not.toBeNull();
    expect(backend.outbox[`note_page:${p.id}`]).toMatchObject({
      purged: false,
    });
  });

  it("round-trips the notebook and its images through the store", async () => {
    const store = new MemoryStore();
    const fileStore = new MemoryFileStore();
    const a = await createMobileBackend({ store, fileStore });
    const c = a.commands;
    const s = await project(a);
    const g = await c.createNoteGroup({ subjectId: s, name: "Décisions" });
    const p = await c.createNotePage({
      subjectId: s,
      groupId: g.id,
      title: "P",
      body: "texte",
      kind: "page",
      sourceTaskId: null,
    });
    const added = await a.files.addToPage(p.id, [
      new File(["abc"], "a.png", { type: "image/png" }),
    ]);
    expect(added).toMatchObject({ added: 1 });
    await a.saveNow();
    const b = await createMobileBackend({ store, fileStore });
    expect(b.notes.groups).toEqual(a.notes.groups);
    expect(b.notes.pages).toEqual(a.notes.pages);
    expect(b.links.attachments).toEqual(a.links.attachments);
    expect((await b.commands.notebook(s)).groups[0].pages[0].id).toBe(p.id);
    expect(await b.commands.listNoteAttachments(p.id)).toHaveLength(1);
    b.diff();
    expect(b.outbox).toEqual(a.outbox);
  });

  it("loads a set saved before the notebook: no group, no page, nothing to send", async () => {
    const store = new MemoryStore();
    const old = emptyPersisted();
    delete old.state.noteGroups;
    delete old.state.notePages;
    const backend = new MobileBackend({ store, persisted: old });
    expect(backend.notes.groups).toEqual([]);
    expect(backend.notes.pages).toEqual([]);
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("an image pasted in another page is copied on the phone; prune keeps what a page shows", async () => {
    const fileStore = new MemoryFileStore();
    const { backend } = makePhone(undefined, { files: fileStore });
    const c = backend.commands;
    const s = await project(backend);
    const mk = (title: string) =>
      c.createNotePage({
        subjectId: s,
        groupId: null,
        title,
        body: "",
        kind: "page",
        sourceTaskId: null,
      });
    const a = await mk("A");
    const b = await mk("B");
    const x = await c.addNoteAttachmentData({
      notePageId: a.id,
      name: "plan.png",
      base64: btoa("PNGDATA"),
    });
    const copy = await c.copyNoteAttachment({ id: x.id, toPageId: b.id });
    expect(copy).toMatchObject({
      notePageId: b.id,
      fileName: "plan.png",
      exists: true,
    });
    expect(backend.outbox[`note_attachment:${copy.id}`]).toBeDefined();
    expect(await (await backend.files.preview(copy.id))?.text()).toBe(
      "PNGDATA",
    );
    // Cut from A, pasted in B without a copy: A's prune keeps it while B shows it.
    await c.updateNotePage({
      id: b.id,
      title: null,
      body: `![[file:${x.id}]]`,
    });
    expect(
      await c.pruneNoteImages({ pageId: a.id, candidateIds: [x.id] }),
    ).toEqual([]);
    await c.updateNotePage({ id: b.id, title: null, body: "" });
    expect(
      await c.pruneNoteImages({ pageId: a.id, candidateIds: [x.id] }),
    ).toEqual([x.id]);
    await backend.files.whenIdle();
    expect(await fileStore.get(x.id)).toBeNull();
    // A file not on this phone cannot be copied.
    await fileStore.delete(copy.id);
    await expect(
      c.copyNoteAttachment({ id: copy.id, toPageId: a.id }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("page images go through the web files layer, with the page as owner", async () => {
    const fileStore = new MemoryFileStore();
    const { backend } = makePhone(undefined, { files: fileStore });
    const c = backend.commands;
    const s = await project(backend);
    const p = await c.createNotePage({
      subjectId: s,
      groupId: null,
      title: "P",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    // Pasted (base64): the same transport as a task's pasted image.
    const pasted = await c.addNoteAttachmentData({
      notePageId: p.id,
      name: "capture.png",
      base64: btoa("PNGDATA"),
    });
    expect(pasted).toMatchObject({
      notePageId: p.id,
      fileName: "capture.png",
      isImage: true,
      size: 7,
      exists: true,
    });
    const picked = await backend.files.addToPage(p.id, [
      new File(["abcd"], "photo.jpg", { type: "image/jpeg" }),
    ]);
    expect(picked.ids).toHaveLength(1);
    expect((await c.listNoteAttachments(p.id)).map((a) => a.fileName)).toEqual([
      "capture.png",
      "photo.jpg",
    ]);
    // Their rows are `note_attachment` rows, with the hash, queued for the sync.
    for (const id of [pasted.id, ...picked.ids]) {
      expect(backend.outbox[`note_attachment:${id}`]).toMatchObject({
        purged: false,
      });
      expect(backend.outbox[`attachment:${id}`]).toBeUndefined();
      expect(wire(backend, `note_attachment:${id}`)).toMatchObject({
        note_page_id: p.id,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(await fileStore.get(id)).not.toBeNull();
    }
    // The bytes come back for the tile and the editor.
    const blob = await backend.files.preview(pasted.id);
    expect(blob?.type).toBe("image/png");
    expect(await blob?.text()).toBe("PNGDATA");
    // A task's tile list holds none of them.
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: s,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    expect((await c.getTask(t.id)).attachments).toEqual([]);
    // Paths do not exist in a browser; a page that is not here is refused.
    await expect(
      c.addNoteAttachments({ notePageId: p.id, paths: ["/tmp/a.png"] }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      backend.files.addToPage("nope", [new File(["x"], "x.png")]),
    ).rejects.toMatchObject({ kind: "not_found" });
    // A page holds only images (task 8): a picked PDF is refused, nothing is kept.
    const kept = (await c.listNoteAttachments(p.id)).length;
    await expect(
      backend.files.addToPage(p.id, [
        new File(["x"], "y.png", { type: "image/png" }),
        new File(["x"], "devis.pdf", { type: "application/pdf" }),
      ]),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      c.addNoteAttachmentData({
        notePageId: p.id,
        name: "devis.pdf",
        base64: "JVBERi0=",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(await c.listNoteAttachments(p.id)).toHaveLength(kept);
    // Deleting an image drops its row (soft) and its kept copy.
    await c.deleteNoteAttachment(pasted.id);
    await backend.files.whenIdle();
    expect(
      wire(backend, `note_attachment:${pasted.id}`).deleted_at,
    ).not.toBeNull();
    expect(await fileStore.get(pasted.id)).toBeNull();
    expect(await c.listNoteAttachments(p.id)).toHaveLength(1);
  });

  it("purging deletes old deleted pages, a project's whole notebook and unlinks a summary, as tombstones", async () => {
    const { backend, clock } = makePhone();
    const c = backend.commands;
    const s = await project(backend, "Gone");
    const keep = await project(backend, "Kept");
    const t = await c.createTask({
      title: "T",
      description: null,
      subjectId: keep,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const page = (
      subjectId: string,
      title: string,
      kind: "page" | "summary" = "page",
    ) =>
      c.createNotePage({
        subjectId,
        groupId: null,
        title,
        body: "",
        kind,
        sourceTaskId: kind === "summary" ? t.id : null,
      });
    const old = await page(keep, "Old");
    const fresh = await page(keep, "Fresh");
    const summary = await page(keep, "Résumé", "summary");
    const inGone = await page(s, "In gone");
    const g = await c.createNoteGroup({ subjectId: s, name: "G" });
    const img = await backend.files.addToPage(old.id, [
      new File(["abc"], "a.png", { type: "image/png" }),
    ]);
    await c.deleteNotePage(old.id);
    await c.deleteSubject(s);
    await c.deleteTask(t.id);
    clock.advance(RETENTION_MS / 2);
    await c.deleteNotePage(fresh.id);
    clock.advance(RETENTION_MS / 2 + 1);
    backend.purge();
    expect(backend.notes.pages.map((p) => p.id).sort()).toEqual(
      [fresh.id, summary.id].sort(),
    );
    expect(backend.notes.groups).toEqual([]);
    expect(backend.links.attachments).toEqual([]);
    for (const k of [
      `note_page:${old.id}`,
      `note_page:${inGone.id}`,
      `note_group:${g.id}`,
      `note_attachment:${img.ids[0]}`,
    ]) {
      expect(backend.outbox[k]?.purged, k).toBe(true);
    }
    // The summary's task is purged too: only unlinked.
    expect(
      backend.notes.pages.find((p) => p.id === summary.id)?.sourceTaskId,
    ).toBeNull();
    expect(backend.outbox[`note_page:${summary.id}`]).toMatchObject({
      purged: false,
    });
    expect(backend.heldDeletions.size).toBe(0);
  });

  it("hands a purged page's images still shown elsewhere to that page (core purge_rows)", async () => {
    const { backend, clock } = makePhone();
    const c = backend.commands;
    const s = await project(backend);
    const original = await c.createNotePage({
      subjectId: s,
      groupId: null,
      title: "Maquettes",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    const img = await backend.files.addToPage(original.id, [
      new File(["abc"], "a.png", { type: "image/png" }),
      new File(["def"], "b.png", { type: "image/png" }),
    ]);
    const [shared, alone] = img.ids;
    await c.updateNotePage({
      id: original.id,
      title: null,
      body: `![[file:${shared}|50%]]\n\n![[file:${alone}]]`,
    });
    const copy = await c.duplicateNotePage(original.id);
    await c.updateNotePage({
      id: copy.id,
      title: null,
      body: `![[file:${shared}|50%]]`,
    });
    await c.deleteNotePage(original.id);
    clock.advance(RETENTION_MS + 1);
    backend.purge();
    expect(backend.notes.pages.map((p) => p.id)).toEqual([copy.id]);
    const kept = backend.links.attachments.find((a) => a.id === shared);
    expect(kept?.notePageId).toBe(copy.id);
    expect(backend.links.attachments.some((a) => a.id === alone)).toBe(false);
    expect(backend.outbox[`note_attachment:${shared}`]).toMatchObject({
      purged: false,
    });
    expect(wire(backend, `note_attachment:${shared}`).note_page_id).toBe(
      copy.id,
    );
    expect(backend.outbox[`note_attachment:${alone}`]?.purged).toBe(true);
    expect((await c.listNoteAttachments(copy.id)).map((a) => a.id)).toEqual([
      shared,
    ]);
  });

  it("the deletion guard holds pages and groups that vanish, and restores them", () => {
    const { backend } = makePhone();
    const changes = [subject("p", AT), noteGroup("g", "p", AT)];
    for (let i = 0; i < 10; i += 1) {
      changes.push(
        notePage(`pg${i}`, "p", AT, { group_id: "g", position: i }),
        noteAttachment(`im${i}`, `pg${i}`, AT),
      );
    }
    backend.applyPulled(changes);
    // What an older web app does to the rows it does not know.
    backend.notes.pages = [];
    backend.notes.groups = [];
    backend.links.attachments = [];
    backend.emitDataChanged(["notes"]);
    expect(backend.heldDeletions.size).toBe(21);
    expect(backend.outbox).toEqual({});
    backend.restoreHeldDeletions();
    expect(backend.notes.pages).toHaveLength(10);
    expect(backend.notes.groups).toHaveLength(1);
    expect(backend.links.attachments).toHaveLength(10);
    expect(
      backend.links.attachments.every((a) => a.notePageId !== undefined),
    ).toBe(true);
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("lets a few deletions through (a purged page's image goes with it, never held)", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", AT),
      notePage("a", "p", AT),
      notePage("b", "p", AT),
      noteAttachment("i", "a", AT),
    ]);
    backend.notes.pages = backend.notes.pages.filter((p) => p.id !== "a");
    backend.links.attachments = [];
    backend.emitDataChanged(["notes"]);
    expect(backend.heldDeletions.size).toBe(0);
    expect(backend.outbox["note_page:a"]?.purged).toBe(true);
    expect(backend.outbox["note_attachment:i"]?.purged).toBe(true);
  });
});
