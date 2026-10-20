import { afterEach, describe, expect, it, vi } from "vitest";
import { ALREADY_LINKED, NOT_ON_THE_PHONE } from "../../lib/mock-sync";
import {
  ALL_ENTITIES,
  type Change,
  changeKey,
  EPOCH_STAMP,
  LEGACY_ENTITIES,
  SETTING_INBOX_POSITION,
} from "../../lib/sync-proto";
import type { MobileBackend } from "../backend";
import { FakeServer } from "../test/fakeServer";
import {
  boardColumn,
  link,
  makePhone,
  noteGroup,
  notePage,
  relation,
  SERVER_URL,
  section,
  subject,
  task,
  timeSegment,
  tombstone,
} from "../test/helpers";
import { POKE_DELAY_MS, type TriggerEnv } from "./engine";

afterEach(() => {
  vi.useRealTimers();
});

const create = (
  b: MobileBackend,
  title: string,
  subjectId: string | null = null,
) =>
  b.commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });

class FakeTarget {
  listeners = new Map<string, Set<() => void>>();
  visibilityState = "visible";
  addEventListener(type: string, l: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(l);
  }
  removeEventListener(type: string, l: () => void) {
    this.listeners.get(type)?.delete(l);
  }
  fire(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

const fakeEnv = () => {
  const window = new FakeTarget();
  const document = new FakeTarget();
  return { env: { window, document } as TriggerEnv, window, document };
};

describe("link and unlink", () => {
  it("maps link errors like the core", async () => {
    const { backend, server } = makePhone();
    await expect(
      backend.commands.syncLogin({
        serverUrl: "ftp://x",
        email: "user@exemple.fr",
        password: "x",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      backend.commands.syncLogin({
        serverUrl: SERVER_URL,
        email: "user@exemple.fr",
        password: "mauvais",
      }),
    ).rejects.toMatchObject({ kind: "sync_auth" });
    // The e-mail counts: the right password of another address is refused too.
    await expect(
      backend.commands.syncLogin({
        serverUrl: SERVER_URL,
        email: "autre@exemple.fr",
        password: server.password,
      }),
    ).rejects.toMatchObject({ kind: "sync_auth" });
    server.canned.push({
      status: 429,
      body: '{"error":"rate_limited","message":"slow down"}',
    });
    await expect(
      backend.commands.syncLogin({
        serverUrl: SERVER_URL,
        email: "user@exemple.fr",
        password: server.password,
      }),
    ).rejects.toMatchObject({ kind: "sync_rate_limited" });
    server.offline = true;
    await expect(
      backend.commands.syncLogin({
        serverUrl: SERVER_URL,
        email: "user@exemple.fr",
        password: server.password,
      }),
    ).rejects.toMatchObject({ kind: "sync_offline" });
    server.offline = false;
    server.canned.push({
      status: 503,
      body: "<html>",
      contentType: "text/html",
    });
    await expect(
      backend.commands.syncLogin({
        serverUrl: SERVER_URL,
        email: "user@exemple.fr",
        password: server.password,
      }),
    ).rejects.toMatchObject({ kind: "sync_server" });
    expect((await backend.commands.syncStatus()).state).toBe("unlinked");
  });

  it("links, pushes the local data and pulls the server's", async () => {
    const server = new FakeServer();
    server.put(subject("mac-project", "2026-10-01T00:00:00.000Z"));
    const phone = makePhone(server);
    await create(phone.backend, "Courses");
    await link(phone);
    const status = await phone.backend.commands.syncStatus();
    expect(status).toMatchObject({
      state: "idle",
      serverUrl: SERVER_URL,
      pending: 0,
      errorKind: null,
    });
    expect(status.lastSyncAt).not.toBeNull();
    expect(phone.backend.state.subjects.map((s) => s.id)).toEqual([
      "mac-project",
    ]);
    const pushed = [...server.records.values()].filter(
      (r) => r.change.entity === "task",
    );
    expect(pushed).toHaveLength(1);
    expect(phone.store.saves).toBeGreaterThan(0);
  });

  it("re-enqueues at link: outbox entries kept, others with their known stamp or the epoch stamp", async () => {
    const phone = makePhone();
    const { backend } = phone;
    const a = await create(backend, "A");
    const b = await create(backend, "B");
    const known = backend.snapshot[`task:${a.id}`].stamp;
    delete backend.outbox[`task:${a.id}`];
    const bEntry = { ...backend.outbox[`task:${b.id}`] };
    // A row with no known version at all (e.g. created before any tracking).
    backend.state.tasks.push({
      ...backend.state.tasks[0],
      id: "legacy",
      title: "legacy",
    });
    const n = backend.reenqueue(EPOCH_STAMP);
    expect(n).toBe(2);
    expect(backend.outbox[`task:${a.id}`].changed_at).toBe(known);
    expect(backend.outbox[`task:${b.id}`]).toEqual(bEntry);
    expect(backend.outbox["task:legacy"].changed_at).toBe(EPOCH_STAMP);
  });

  it("unlink keeps the address, the data and the outbox", async () => {
    const phone = makePhone();
    await link(phone);
    await create(phone.backend, "après");
    const status = await phone.backend.commands.syncUnlink();
    expect(status).toMatchObject({ state: "unlinked", serverUrl: SERVER_URL });
    expect(phone.backend.pendingCount()).toBe(1);
    expect(phone.server.tokens.size).toBe(0);
  });

  it("relink pushes an edit made while unlinked with its own stamp", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const t = await create(phone.backend, "A");
    await link(phone);
    await phone.backend.commands.syncUnlink();
    phone.clock.advance(60_000);
    await phone.backend.commands.setTaskCompleted({
      id: t.id,
      completed: true,
    });
    const stamp = phone.backend.outbox[`task:${t.id}`].changed_at;
    await link(phone);
    const stored = server.get(`task:${t.id}`);
    expect(stored?.updated_at).toBe(stamp);
    expect(stored?.data).toMatchObject({ completed_at: expect.any(String) });
  });

  it("sets the interval", async () => {
    const { backend } = makePhone();
    await expect(backend.commands.syncSetInterval(7)).rejects.toMatchObject({
      kind: "invalid",
    });
    expect((await backend.commands.syncSetInterval(15)).intervalMinutes).toBe(
      15,
    );
  });
});

describe("one run", () => {
  it("converges two phones through the server", async () => {
    const server = new FakeServer();
    const a = makePhone(server);
    const b = makePhone(server);
    await link(a);
    await link(b);
    const s = await a.backend.commands.createSubject({
      name: "Perso",
      color: null,
      rootPath: null,
      parentId: null,
    });
    // Only a group holds projects (synced since protocol 3).
    const group = a.backend.state.subjects.find((x) => x.id === s.id);
    if (group) group.isGroup = true;
    const sub = await a.backend.commands.createSubject({
      name: "Maison",
      color: null,
      rootPath: null,
      parentId: s.id,
    });
    const t = await create(a.backend, "Peindre", sub.id);
    await a.backend.commands.addSubtask({ taskId: t.id, text: "Acheter" });
    await a.backend.commands.updateTask({
      id: t.id,
      title: null,
      description: "blanc",
    });
    await a.backend.engine.syncNow();
    await b.backend.engine.syncNow();
    expect(b.backend.state.subjects.map((x) => x.name).sort()).toEqual([
      "Maison",
      "Perso",
    ]);
    expect(b.backend.state.subjects.find((x) => x.id === s.id)?.isGroup).toBe(
      true,
    );
    expect(b.backend.state.tasks.map((x) => x.title).sort()).toEqual([
      "Acheter",
      "Peindre",
    ]);
    expect(b.backend.state.tasks.find((x) => x.id === t.id)?.description).toBe(
      "blanc",
    );
    expect(b.backend.pendingCount()).toBe(0);

    // B completes, then deletes; A sees both.
    b.clock.advance(1000);
    await b.backend.commands.setTaskCompleted({ id: t.id, completed: true });
    await b.backend.engine.syncNow();
    await a.backend.engine.syncNow();
    expect(
      a.backend.state.tasks.find((x) => x.id === t.id)?.completedAt,
    ).not.toBeNull();
    // A sync with nothing to do changes nothing.
    expect(a.backend.pendingCount()).toBe(0);
  });

  it("pushes 1 200 entries in 3 requests, storing the cursor after each", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    for (let i = 0; i < 1200; i += 1) {
      phone.backend.state.tasks.push({
        id: `t${i}`,
        parentId: null,
        priority: 1,
        subjectId: null,
        sectionId: null,
        title: `T${i}`,
        description: "",
        dueDate: null,
        dueTime: null,
        workdirOverride: null,
        completedAt: null,
        position: i + 1,
        createdAt: phone.clock.iso(),
        updatedAt: phone.clock.iso(),
        deletedAt: null,
      });
    }
    phone.backend.emitDataChanged(["tasks"]);
    server.requests = [];
    const cursors: number[] = [];
    server.onSync = () => {
      cursors.push(phone.backend.syncData.cursor);
    };
    await phone.backend.engine.syncNow();
    expect(server.requests.map((r) => r.changes.length)).toEqual([
      500, 500, 200,
    ]);
    expect(cursors).toEqual([0, 500, 1000]);
    expect(phone.backend.syncData.cursor).toBe(1200);
    expect(phone.backend.pendingCount()).toBe(0);
  });

  it("follows has_more until the last page", async () => {
    const server = new FakeServer();
    server.pageSize = 3;
    for (let i = 0; i < 7; i += 1) {
      server.put(task(`m${i}`, "2026-10-01T00:00:00.000Z"));
    }
    const phone = makePhone(server);
    await link(phone);
    // Three pages in the link's run, then the extra run of `link()`.
    expect(server.requests.map((r) => r.cursor)).toEqual([0, 3, 6, 7]);
    expect(phone.backend.state.tasks).toHaveLength(7);
    expect(phone.backend.syncData.cursor).toBe(7);
  });

  it("halves the chunk on 413", async () => {
    const server = new FakeServer();
    server.maxChanges = 2;
    const phone = makePhone(server);
    for (const t of ["A", "B", "C", "D", "E"]) await create(phone.backend, t);
    await link(phone);
    expect(phone.backend.pendingCount()).toBe(0);
    expect(server.requests.every((r) => r.changes.length <= 2)).toBe(true);
    expect(server.records.size).toBe(5);
  });

  it("drops rejected entries", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const bad = await create(phone.backend, "refusé");
    await create(phone.backend, "accepté");
    server.rejectIds.add(bad.id);
    await link(phone);
    expect(phone.backend.pendingCount()).toBe(0);
    expect(server.records.size).toBe(1);
  });

  it("returns the server's newer row when an older push is refused", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const t = await create(phone.backend, "local");
    await link(phone);
    server.put(task(t.id, "2030-01-01T00:00:00.000Z", { title: "serveur" }));
    // Push an older edit with a cursor above the server row: the server sends it back.
    phone.backend.syncData.cursor = server.maxRev;
    await phone.backend.commands.updateTask({
      id: t.id,
      title: "vieux",
      description: null,
    });
    await phone.backend.engine.syncNow();
    expect(phone.backend.state.tasks[0].title).toBe("serveur");
    expect(phone.backend.pendingCount()).toBe(0);
  });

  it("skips a pulled row edited locally while in flight, and pushes the edit next", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const t = await create(phone.backend, "A");
    await link(phone);
    server.put(task(t.id, "2026-10-04T10:00:00.500Z", { title: "Mac" }));
    server.onSync = async () => {
      server.onSync = null;
      phone.clock.advance(1000);
      await phone.backend.commands.updateTask({
        id: t.id,
        title: "Téléphone",
        description: null,
      });
    };
    await phone.backend.engine.syncNow();
    expect(phone.backend.state.tasks[0].title).toBe("Téléphone");
    expect(phone.backend.pendingCount()).toBe(1);
    await phone.backend.engine.syncNow();
    expect(server.get(`task:${t.id}`)?.data).toMatchObject({
      title: "Téléphone",
    });
    expect(phone.backend.pendingCount()).toBe(0);
  });

  it("parks a child pulled before its parent across two runs", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    server.put(task("kid", "2026-10-01T00:00:00.000Z", { parent_id: "dad" }));
    await phone.backend.engine.syncNow();
    expect(phone.backend.state.tasks).toEqual([]);
    expect(Object.keys(phone.backend.parked)).toEqual(["task:kid"]);
    server.put(task("dad", "2026-10-01T00:00:00.000Z"));
    await phone.backend.engine.syncNow();
    expect(phone.backend.state.tasks.map((t) => t.id).sort()).toEqual([
      "dad",
      "kid",
    ]);
    expect(phone.backend.parked).toEqual({});
  });

  it("rebuilds the server after an epoch change (newer local row wins back)", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const t = await create(phone.backend, "A");
    await link(phone);
    phone.clock.advance(1000);
    await phone.backend.commands.updateTask({
      id: t.id,
      title: "A2",
      description: null,
    });
    await phone.backend.engine.syncNow();
    // Restore of an older backup: the old row, another epoch.
    const old = { ...task(t.id, "2026-10-04T10:00:00.000Z", { title: "A" }) };
    server.reset("epoch-2");
    server.put(old);
    await phone.backend.engine.syncNow();
    expect(phone.backend.syncData.serverEpoch).toBe("epoch-2");
    expect(server.get(`task:${t.id}`)?.data).toMatchObject({ title: "A2" });
    expect(phone.backend.state.tasks[0].title).toBe("A2");
    expect(phone.backend.pendingCount()).toBe(0);
  });

  it("reports offline, unauthorized, server and protocol errors", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    server.offline = true;
    expect((await phone.backend.engine.syncNow()).state).toBe("offline");
    server.offline = false;
    server.canned.push({ status: 401, body: '{"error":"unauthorized"}' });
    expect(await phone.backend.engine.syncNow()).toMatchObject({
      state: "error",
      errorKind: "unauthorized",
    });
    server.canned.push({
      status: 403,
      body: "<html>challenge</html>",
      contentType: "text/html",
    });
    expect((await phone.backend.engine.syncNow()).errorKind).toBe("server");
    server.canned.push({ status: 500, body: "{oops" });
    expect((await phone.backend.engine.syncNow()).errorKind).toBe("server");
    server.canned.push({
      status: 400,
      body: '{"error":"unsupported_protocol","message":"x"}',
    });
    expect((await phone.backend.engine.syncNow()).errorKind).toBe(
      "unsupported_protocol",
    );
    expect((await phone.backend.engine.syncNow()).state).toBe("idle");
  });

  it("shows deletions_held while deletions wait, and keeps syncing the rest", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    for (let i = 0; i < 30; i += 1) await create(phone.backend, `T${i}`);
    await link(phone);
    phone.backend.state.tasks = [];
    phone.backend.emitDataChanged(["tasks"]);
    await create(phone.backend, "nouvelle");
    const status = await phone.backend.engine.syncNow();
    expect(status).toMatchObject({
      state: "error",
      errorKind: "deletions_held",
    });
    expect(server.records.size).toBe(31);
    phone.backend.confirmHeldDeletions();
    await phone.backend.engine.syncNow();
    const tombstones = [...server.records.values()].filter(
      (r) => r.change.data === null,
    );
    expect(tombstones).toHaveLength(30);
    expect((await phone.backend.commands.syncStatus()).state).toBe("idle");
  });

  it("purges after the first successful run when linked", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const t = await create(phone.backend, "vieux");
    await phone.backend.commands.deleteTask(t.id);
    await link(phone);
    expect(phone.backend.state.tasks).toHaveLength(1);
    phone.clock.advance(25 * 60 * 60 * 1000);
    // Next session: a fresh engine purges after its first successful run.
    const again = makePhone(server, {
      persisted: phone.backend.persisted(),
      clock: phone.clock,
    });
    await again.backend.engine.syncNow();
    expect(again.backend.state.tasks).toEqual([]);
    await again.backend.engine.syncNow();
    expect(server.get(`task:${t.id}`)?.data).toBeNull();
  });
});

describe("triggers", () => {
  it("runs after start, 3 s after a local change, on interval, when back online or visible", async () => {
    vi.useFakeTimers();
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    const { env, window, document } = fakeEnv();
    const count = () => server.requests.length;
    let before = count();
    phone.backend.engine.start(env);
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(before + 1);

    before = count();
    await create(phone.backend, "A");
    await vi.advanceTimersByTimeAsync(POKE_DELAY_MS - 100);
    expect(count()).toBe(before);
    await vi.advanceTimersByTimeAsync(200);
    expect(count()).toBe(before + 1);
    expect(phone.backend.pendingCount()).toBe(0);

    before = count();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(count()).toBe(before + 1);

    // Offline: the change waits, then leaves when the network comes back.
    server.offline = true;
    await create(phone.backend, "hors ligne");
    await vi.advanceTimersByTimeAsync(POKE_DELAY_MS + 10);
    expect((await phone.backend.commands.syncStatus()).state).toBe("offline");
    expect(phone.backend.pendingCount()).toBe(1);
    server.offline = false;
    window.fire("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.backend.pendingCount()).toBe(0);

    before = count();
    document.visibilityState = "visible";
    document.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(before + 1);
    phone.backend.engine.stop();
  });

  it("saves at once when the page is hidden or closed", async () => {
    vi.useFakeTimers();
    const phone = makePhone();
    const { env, window, document } = fakeEnv();
    phone.backend.engine.start(env);
    await create(phone.backend, "A");
    expect(phone.store.saves).toBe(0);
    window.fire("pagehide");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.store.saves).toBe(1);
    await create(phone.backend, "B");
    document.visibilityState = "hidden";
    document.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(phone.store.saves).toBe(2);
    expect(phone.store.data.state).toMatchObject({
      tasks: [{ title: "A" }, { title: "B" }],
    });
    phone.backend.engine.stop();
  });
});

describe("shared settings", () => {
  const INBOX_KEY = `setting:${SETTING_INBOX_POSITION}`;

  it("syncs the inbox position between two phones, last writer wins", async () => {
    const server = new FakeServer();
    const a = makePhone(server);
    const b = makePhone(server);
    for (const name of ["A", "B"]) {
      await a.backend.commands.createSubject({
        name,
        color: null,
        rootPath: null,
        parentId: null,
      });
    }
    await link(a);
    await link(b);
    expect(b.backend.state.syncedSettings).toEqual({});
    expect(await b.backend.commands.getInboxIndex()).toBe(2);

    await a.backend.commands.reorderInbox(0);
    await a.backend.engine.syncNow();
    expect(server.get(INBOX_KEY)?.data).toEqual({ value: 0 });
    await b.backend.engine.syncNow();
    expect(await b.backend.commands.getInboxIndex()).toBe(0);
    expect(b.backend.pendingCount()).toBe(0);

    // B moves it later: A gets B's value.
    b.clock.advance(1000);
    await b.backend.commands.reorderInbox(1);
    await b.backend.engine.syncNow();
    await a.backend.engine.syncNow();
    expect(await a.backend.commands.getInboxIndex()).toBe(1);
    expect(a.backend.state.syncedSettings).toEqual(
      b.backend.state.syncedSettings,
    );
    expect(a.backend.pendingCount()).toBe(0);
  });

  it("sends the setting again after an epoch change", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await phone.backend.commands.reorderInbox(0);
    await link(phone);
    expect(server.get(INBOX_KEY)?.data).toEqual({ value: 1 });
    server.reset("epoch-2");
    await phone.backend.engine.syncNow();
    expect(server.get(INBOX_KEY)?.data).toEqual({ value: 1 });
    expect(phone.backend.pendingCount()).toBe(0);
  });
});

describe("protocol 3", () => {
  const MAC = "2026-10-01T00:00:00.000Z";
  const LATER = "2026-10-01T00:00:05.000Z";

  /** What the Mac pushed: a group, a project in it with its board, a task in « À valider ». */
  function macServer(): FakeServer {
    const server = new FakeServer();
    server.put(subject("grp", MAC, { name: "Clients", is_group: true }));
    server.put(subject("proj", MAC, { name: "Site", parent_id: "grp" }));
    for (const [i, name] of ["À faire", "En cours", "À valider"].entries()) {
      server.put(
        boardColumn(`col-proj-${i}`, "proj", MAC, { name, position: i }),
      );
    }
    server.put(
      boardColumn("col-proj-3", "proj", MAC, {
        name: "Terminé",
        position: 3,
        is_done: true,
      }),
    );
    server.put(
      task("t", MAC, {
        subject_id: "proj",
        title: "Maquette",
        board_column_id: "col-proj-2",
      }),
    );
    return server;
  }

  it("review point 3: a task in « À valider » and a group stay so when the phone renames them", async () => {
    const server = macServer();
    const phone = makePhone(server);
    await link(phone);
    const { backend } = phone;
    expect(backend.state.subjects.find((x) => x.id === "grp")?.isGroup).toBe(
      true,
    );
    expect(
      (await backend.commands.listSubjects()).find((x) => x.id === "grp")
        ?.isGroup,
    ).toBe(true);
    expect(backend.pendingCount()).toBe(0);

    phone.clock.advance(60_000);
    await backend.commands.updateTask({
      id: "t",
      title: "Maquette v2",
      description: null,
    });
    await backend.commands.updateSubject({
      id: "grp",
      name: "Clients 2026",
      color: null,
      rootPath: null,
      parentId: null,
    });
    // Only the two renamed rows go out.
    expect(Object.keys(backend.outbox).sort()).toEqual([
      "subject:grp",
      "task:t",
    ]);
    await backend.engine.syncNow();
    expect(backend.pendingCount()).toBe(0);
    expect(server.get("task:t")?.data).toMatchObject({
      title: "Maquette v2",
      board_column_id: "col-proj-2",
    });
    expect(server.get("subject:grp")?.data).toMatchObject({
      name: "Clients 2026",
      is_group: true,
    });
    // The columns themselves were never sent back.
    expect(server.get("board_column:col-proj-2")?.device_id).toBe("mac");

    // Another phone sees the same.
    const other = makePhone(server);
    await link(other);
    expect(other.backend.state.tasks.find((x) => x.id === "t")).toMatchObject({
      title: "Maquette v2",
      boardColumnId: "col-proj-2",
    });
    expect(
      other.backend.state.subjects.find((x) => x.id === "grp"),
    ).toMatchObject({ name: "Clients 2026", isGroup: true });
  });

  it("keeps the group and the column across a reload, and a later Mac move wins", async () => {
    const server = macServer();
    const phone = makePhone(server);
    await link(phone);
    const again = makePhone(server, {
      persisted: phone.backend.persisted(),
      clock: phone.clock,
    });
    expect(
      again.backend.state.tasks.find((x) => x.id === "t")?.boardColumnId,
    ).toBe("col-proj-2");
    // The Mac moves the task back to « En cours », and ungroups nothing: the phone follows.
    server.put(
      task("t", LATER, {
        subject_id: "proj",
        title: "Maquette",
        board_column_id: "col-proj-1",
      }),
    );
    await again.backend.engine.syncNow();
    expect(
      again.backend.state.tasks.find((x) => x.id === "t")?.boardColumnId,
    ).toBe("col-proj-1");
    expect(again.backend.pendingCount()).toBe(0);
  });

  it("holds the Mac's columns, segments, relations and attachments, parks the orphans, sends nothing back", async () => {
    const server = macServer();
    server.put(timeSegment("seg-1", "t", MAC, { ended_at: LATER }));
    server.put(timeSegment("seg-2", "t", LATER));
    server.put(relation("rel-1", "t", "absent", MAC));
    server.put({
      entity: "attachment",
      id: "att-1",
      updated_at: MAC,
      device_id: "mac",
      data: {
        task_id: "t",
        file_name: "devis.pdf",
        mime_type: "application/pdf",
        size: 1234,
        created_at: MAC,
        deleted_at: null,
      },
    } as Change);
    // A segment whose task the phone never sees, then a segment tombstone.
    server.put(timeSegment("seg-orphan", "absent", MAC));
    server.put(tombstone("time_segment", "seg-1", LATER));
    server.put(section("sec", "proj", MAC));
    const phone = makePhone(server);
    await link(phone);
    const { backend } = phone;
    expect(await backend.commands.syncStatus()).toMatchObject({
      state: "idle",
      errorKind: null,
      pending: 0,
    });
    expect(backend.syncData.cursor).toBe(server.maxRev);
    expect(Object.keys(backend.parked).sort()).toEqual([
      "relation:rel-1",
      "time_segment:seg-orphan",
    ]);
    expect(backend.chrono.segments.map((x) => x.id)).toEqual(["seg-2"]);
    expect(backend.snapshot["time_segment:seg-2"]?.stamp).toBe(LATER);
    expect(backend.snapshot["board_column:col-proj-2"]?.stamp).toBe(MAC);
    expect(
      (await backend.commands.getTask("t")).attachments.map((a) => a.fileName),
    ).toEqual(["devis.pdf"]);
    // The Mac's board, as the Mac has it: no default made over it.
    const board = await backend.commands.getBoard("proj");
    expect(board.columns.map((c) => [c.name, c.cards.length])).toEqual([
      ["À faire", 0],
      ["En cours", 0],
      ["À valider", 1],
      ["Terminé", 0],
    ]);
    server.requests = [];
    await backend.engine.syncNow();
    expect(server.requests.map((r) => r.changes.length)).toEqual([0]);
    expect(server.get("time_segment:seg-2")?.device_id).toBe("mac");
  });

  it("review point 3: a card moved on the phone reaches the Mac, and a Mac move reaches the phone", async () => {
    const server = macServer();
    const phone = makePhone(server);
    await link(phone);
    const { backend } = phone;
    phone.clock.advance(60_000);
    await backend.commands.moveTaskToColumn({
      taskId: "t",
      columnId: "col-proj-1",
    });
    expect(Object.keys(backend.outbox)).toEqual(["task:t"]);
    await backend.engine.syncNow();
    expect(server.get("task:t")?.data).toMatchObject({
      board_column_id: "col-proj-1",
    });
    // The Mac renames a column and moves the card back.
    server.put(
      boardColumn("col-proj-2", "proj", LATER, {
        name: "Relecture",
        position: 2,
      }),
    );
    server.put(
      task("t", new Date(phone.clock.t + 60_000).toISOString(), {
        subject_id: "proj",
        title: "Maquette",
        board_column_id: "col-proj-2",
      }),
    );
    await backend.engine.syncNow();
    const board = await backend.commands.getBoard("proj");
    expect(board.columns[2]).toMatchObject({ name: "Relecture", total: 1 });
    expect(backend.pendingCount()).toBe(0);
  });

  it("review point 1: a segment running on a Mac is never stopped nor changed by the phone; manual time and relations go out", async () => {
    const server = macServer();
    server.put(task("u", MAC, { subject_id: "proj", title: "Autre" }));
    server.put(timeSegment("mac-run", "t", MAC));
    const phone = makePhone(server);
    await link(phone);
    const { backend } = phone;
    phone.clock.advance(60_000);
    await backend.commands.setTaskCompleted({ id: "t", completed: true });
    await backend.commands.setTaskCompleted({ id: "t", completed: false });
    await backend.commands.addManualTime({
      taskId: "t",
      minutes: 15,
      note: "Appel",
    });
    await backend.commands.addRelation({
      taskId: "t",
      otherId: "u",
      kind: "blocks",
    });
    await backend.commands.deleteTask("t");
    const segment = backend.chrono.segments.find((x) => x.id === "mac-run");
    await expect(
      backend.commands.deleteTimeSegment("mac-run"),
    ).rejects.toMatchObject({ kind: "not_found" });
    await backend.engine.syncNow();
    expect(server.get("time_segment:mac-run")?.data).toMatchObject({
      ended_at: null,
      stop_reason: null,
    });
    expect(server.get("time_segment:mac-run")?.device_id).toBe("mac");
    expect(segment).toMatchObject({ endedAt: null, deletedAt: null });
    const sent = [...server.records.values()]
      .map((s) => s.change)
      .filter((c) => c.device_id !== "mac");
    expect(sent.map((c) => changeKey(c)).sort()).toEqual(
      [
        "task:t",
        `time_segment:${backend.chrono.segments.find((x) => x.source === "manual")?.id}`,
        `relation:${backend.links.relations[0].id}`,
      ].sort(),
    );
    expect(sent.find((c) => c.entity === "time_segment")?.data).toMatchObject({
      task_id: "t",
      source: "manual",
      note: "Appel",
    });
  });

  it("« Arrêter » on the phone stops a Mac's running segment and queues the stop (no reason)", async () => {
    const server = macServer();
    server.put(timeSegment("mac-run", "t", MAC));
    const phone = makePhone(server);
    await link(phone);
    const { backend } = phone;
    const started = server.get("time_segment:mac-run")?.data as {
      started_at: string;
    };
    phone.clock.advance(60_000);
    const detail = await backend.commands.stopTimeSegment("mac-run");
    expect(detail.time.chrono.runningSince).toBeNull();
    const at = new Date(phone.clock.t).toISOString();
    await backend.engine.syncNow();
    const row = server.get("time_segment:mac-run");
    expect(row?.device_id).not.toBe("mac");
    expect(row?.data).toMatchObject({
      started_at: started.started_at,
      ended_at: at < started.started_at ? started.started_at : at,
      stop_reason: null,
    });
    // Stopping again is a no-op; a stopped segment is removed like any other.
    await backend.commands.stopTimeSegment("mac-run");
    await backend.commands.deleteTimeSegment("mac-run");
    await backend.engine.syncNow();
    expect(server.get("time_segment:mac-run")?.data).toMatchObject({
      deleted_at: at,
    });
  });

  it("review point 2: default columns are made with the Mac's ids, only after the first pull, and never twice", async () => {
    // The Mac made the « Sans projet » board and renamed a column.
    const server = new FakeServer();
    for (const [i, name] of [
      "À faire",
      "Côté Mac",
      "À valider",
      "Terminé",
    ].entries()) {
      server.put(
        boardColumn(`col-inbox-${i}`, null, MAC, {
          name,
          position: i,
          is_done: i === 3,
        }),
      );
    }
    // A phone that made its own board before linking: same ids, queued at the epoch stamp.
    const early = makePhone(server);
    expect((await early.backend.commands.getBoard(null)).columns[1].name).toBe(
      "En cours",
    );
    expect(early.backend.outbox["board_column:col-inbox-1"]?.changed_at).toBe(
      EPOCH_STAMP,
    );
    await link(early);
    expect(early.backend.board.columns.map((c) => c.id)).toEqual(
      [0, 1, 2, 3].map((i) => `col-inbox-${i}`),
    );
    expect((await early.backend.commands.getBoard(null)).columns[1].name).toBe(
      "Côté Mac",
    );
    expect(server.get("board_column:col-inbox-1")?.data).toMatchObject({
      name: "Côté Mac",
    });

    // A linked phone before its first whole pull (just logged in, offline) shows an empty
    // board and makes nothing.
    const seed = makePhone(server);
    await link(seed);
    const set = seed.backend.persisted();
    delete set.sync.pulledOnce;
    set.sync.cursor = 0;
    set.state.boardColumns = [];
    set.snapshot = {};
    const late = makePhone(server, { persisted: set });
    server.offline = true;
    await late.backend.engine.syncNow();
    expect((await late.backend.commands.getBoard(null)).columns).toEqual([]);
    expect(late.backend.board.columns).toEqual([]);
    server.offline = false;
    await late.backend.engine.syncNow();
    expect(
      (await late.backend.commands.getBoard(null)).columns.map((c) => c.name),
    ).toEqual(["À faire", "Côté Mac", "À valider", "Terminé"]);

    // After the first pull, a new project's board is made here, with the fixed ids.
    const p = await late.backend.commands.createSubject({
      name: "Neuf",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const board = await late.backend.commands.getBoard(p.id);
    expect(board.columns.map((c) => c.id)).toEqual(
      [0, 1, 2, 3].map((i) => `col-${p.id}-${i}`),
    );
    await late.backend.engine.syncNow();
    expect(server.get(`board_column:col-${p.id}-0`)?.data).toMatchObject({
      subject_id: p.id,
      name: "À faire",
    });
    const columns = [...server.records.keys()].filter((k) =>
      k.startsWith("board_column:"),
    );
    expect(columns).toHaveLength(8);
  });
});

describe("the notebook's entities", () => {
  const S = "2026-10-01T00:00:00.000Z";

  it("declares every entity in each request, and stores the list it declared", async () => {
    const phone = makePhone();
    await link(phone);
    expect(phone.server.requests.length).toBeGreaterThan(0);
    for (const r of phone.server.requests) {
      expect(r.known_entities).toEqual([...ALL_ENTITIES]);
    }
    expect(phone.backend.syncData.knownEntities).toEqual([...ALL_ENTITIES]);
  });

  it("receives the notebook's rows the server holds, created before it declared them", async () => {
    const server = new FakeServer();
    server.put(subject("p", S));
    server.put(noteGroup("g", "p", S, { name: "Décisions" }));
    server.put(notePage("pg", "p", S, { group_id: "g", title: "Accès" }));
    // A phone that updated: it had pulled everything its old build understood (cursor at the
    // end), and stored no declaration.
    const phone = makePhone(server);
    await link(phone);
    expect(phone.backend.notes.pages.map((p) => p.title)).toEqual(["Accès"]);
    phone.backend.syncData.knownEntities = [...LEGACY_ENTITIES];
    phone.backend.notes.pages = [];
    phone.backend.notes.groups = [];
    for (const k of ["note_group:g", "note_page:pg"]) {
      delete phone.backend.snapshot[k];
    }
    const cursor = phone.backend.syncData.cursor;
    expect(cursor).toBe(server.maxRev);
    await phone.backend.engine.syncNow();
    // The grown list sent the cursor back to 0, once.
    const last = server.requests.at(-1);
    expect(last?.cursor).toBe(0);
    expect(phone.backend.notes.pages.map((p) => p.title)).toEqual(["Accès"]);
    expect(phone.backend.syncData.knownEntities).toEqual([...ALL_ENTITIES]);
    expect(phone.backend.syncData.cursor).toBe(server.maxRev);
    await phone.backend.engine.syncNow();
    expect(server.requests.at(-1)?.cursor).toBe(server.maxRev);
  });

  it("a phone without a stored declaration pulls again from 0 once, keeping its unsent edits", async () => {
    const phone = makePhone();
    await link(phone);
    delete phone.backend.syncData.knownEntities;
    await create(phone.backend, "Pas encore envoyée");
    const pending = Object.keys(phone.backend.outbox);
    expect(pending).toHaveLength(1);
    await phone.backend.engine.syncNow();
    expect(phone.server.requests.at(-2)?.cursor).toBe(0);
    expect(phone.backend.pendingCount()).toBe(0);
    expect(phone.server.get(pending[0])).toBeDefined();
  });

  it("ignores the rows of an entity it does not know, without error", async () => {
    const server = new FakeServer();
    // Past the server's `known_entities` filter, so that the phone really receives it.
    server.unfiltered.push({
      entity: "comment",
      id: "c-1",
      updated_at: S,
      device_id: "mac",
      data: { text: "?" },
    } as unknown as Change);
    server.put(subject("p", S));
    let delivered = false;
    const fetch = server.fetch;
    server.fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith("/api/sync")) {
        const body = (await res.clone().json()) as { changes?: Change[] };
        if (body.changes?.some((c) => (c.entity as string) === "comment")) {
          delivered = true;
        }
      }
      return res;
    };
    const phone = makePhone(server);
    await link(phone);
    expect(delivered).toBe(true);
    expect(phone.backend.state.subjects.map((x) => x.id)).toEqual(["p"]);
    expect(phone.backend.syncData.errorKind).toBeNull();
    expect(Object.keys(phone.backend.parked)).toEqual([]);
  });
});

describe("account", () => {
  it("logs in with the e-mail, reads the account, keeps it across reloads and forgets it at unlink", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const { backend } = phone;
    expect(await backend.commands.syncAccount()).toBeNull();
    await backend.commands.syncLogin({
      serverUrl: SERVER_URL,
      email: "  User@Exemple.FR ",
      password: server.password,
    });
    expect(server.accountReads).toBeGreaterThanOrEqual(1);
    expect(await backend.commands.syncAccount()).toEqual({
      email: "user@exemple.fr",
      emailVerified: true,
    });
    await backend.engine.syncNow();
    expect(await backend.commands.syncAccount()).toEqual({
      email: "user@exemple.fr",
      emailVerified: true,
    });
    const reloaded = makePhone(server, {
      persisted: backend.persisted(),
      clock: phone.clock,
    });
    expect(await reloaded.backend.commands.syncAccount()).toEqual({
      email: "user@exemple.fr",
      emailVerified: true,
    });
    await reloaded.backend.commands.syncUnlink();
    expect(await reloaded.backend.commands.syncAccount()).toBeNull();
    expect(reloaded.backend.persisted().sync.account).toBeNull();
  });

  it("accepts an account response with or without plan", async () => {
    for (const legacyPlan of [null, "pro", "free"]) {
      const server = new FakeServer();
      server.legacyPlan = legacyPlan;
      const phone = makePhone(server);
      await phone.backend.commands.syncLogin({
        serverUrl: SERVER_URL,
        email: "user@exemple.fr",
        password: server.password,
      });
      expect(server.accountReads).toBeGreaterThanOrEqual(1);
      // Nothing of the old plan is kept.
      expect(await phone.backend.commands.syncAccount()).toEqual({
        email: "user@exemple.fr",
        emailVerified: true,
      });
    }
  });

  it("a failed account read never fails the login nor the sync", async () => {
    const server = new FakeServer();
    server.accountBroken = true;
    const phone = makePhone(server);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await link(phone);
    expect((await phone.backend.commands.syncStatus()).state).toBe("idle");
    expect(await phone.backend.commands.syncAccount()).toBeNull();
    server.accountBroken = false;
    await phone.backend.engine.syncNow();
    expect((await phone.backend.commands.syncAccount())?.email).toBe(
      "user@exemple.fr",
    );
    warn.mockRestore();
  });

  it("refuses another account while linked, allows a re-login to the same one", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    await link(phone);
    const before = phone.backend.persisted().sync;
    const other = phone.backend.commands.syncLogin({
      serverUrl: SERVER_URL,
      email: "autre@exemple.fr",
      password: "un autre mot de passe",
    });
    await expect(other).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining(ALREADY_LINKED),
    });
    expect(phone.backend.persisted().sync.token).toBe(before.token);
    // The token was refused (password changed on the Mac): log in again, same account.
    server.tokens.clear();
    expect((await phone.backend.engine.syncNow()).errorKind).toBe(
      "unauthorized",
    );
    const status = await phone.backend.commands.syncLogin({
      serverUrl: SERVER_URL,
      email: " USER@exemple.fr",
      password: server.password,
    });
    expect(status.state).not.toBe("unlinked");
    await phone.backend.engine.syncNow();
    expect(await phone.backend.commands.syncStatus()).toMatchObject({
      state: "idle",
      errorKind: null,
    });
  });

  it("a login forgets what the previous server taught: cursor, epoch, known versions, parked rows", async () => {
    const server = new FakeServer();
    server.put(task("kid", "2026-10-01T00:00:00.000Z", { parent_id: "dad" }));
    const phone = makePhone(server);
    const t = await create(phone.backend, "Local");
    await link(phone);
    expect(Object.keys(phone.backend.parked)).toEqual(["task:kid"]);
    await phone.backend.commands.syncUnlink();

    // Another account on another server (same data on the phone, reloaded).
    const next = new FakeServer();
    next.epoch = "epoch-other";
    const routed = makePhone(next, {
      persisted: phone.backend.persisted(),
      clock: phone.clock,
    });
    await routed.backend.commands.syncLogin({
      serverUrl: "https://autre.test",
      email: "user@exemple.fr",
      password: next.password,
    });
    expect(routed.backend.parked).toEqual({});
    expect(routed.backend.syncData.serverEpoch).toBe("epoch-other");
    // Every row went out at the epoch stamp: no version is known on this account.
    await routed.backend.engine.syncNow();
    expect(next.get(`task:${t.id}`)?.updated_at).toBe(EPOCH_STAMP);
    expect(next.get("task:kid")).toBeUndefined();
  });

  it("an edit made before a login keeps its own stamp and is pushed; untouched rows go at the epoch stamp", async () => {
    const server = new FakeServer();
    const phone = makePhone(server);
    const edited = await create(phone.backend, "Avant");
    const untouched = await create(phone.backend, "Pareil");
    await link(phone);
    await phone.backend.commands.syncUnlink();
    phone.clock.advance(60_000);
    await phone.backend.commands.updateTask({
      id: edited.id,
      title: "Modifiée hors compte",
      description: null,
    });
    const stamp = phone.backend.outbox[`task:${edited.id}`].changed_at;
    expect(stamp > EPOCH_STAMP).toBe(true);

    // Another account: the edit survives the login and goes out with its stamp.
    const next = new FakeServer();
    const again = makePhone(next, {
      persisted: phone.backend.persisted(),
      clock: phone.clock,
    });
    await again.backend.commands.syncLogin({
      serverUrl: SERVER_URL,
      email: "user@exemple.fr",
      password: next.password,
    });
    expect(again.backend.outbox[`task:${edited.id}`]?.changed_at).toBe(stamp);
    await again.backend.engine.syncNow();
    expect(next.get(`task:${edited.id}`)).toMatchObject({
      updated_at: stamp,
      data: { title: "Modifiée hors compte" },
    });
    expect(next.get(`task:${untouched.id}`)?.updated_at).toBe(EPOCH_STAMP);
    expect(again.backend.pendingCount()).toBe(0);
  });

  it("refuses signup and the forgotten password on the phone with a clear refusal", async () => {
    const { backend } = makePhone();
    for (const call of [
      () =>
        backend.commands.syncSignup({
          serverUrl: SERVER_URL,
          email: "user@exemple.fr",
          password: "un mot de passe",
        }),
      () =>
        backend.commands.syncForgotPassword({
          serverUrl: SERVER_URL,
          email: "user@exemple.fr",
        }),
      () =>
        backend.commands.syncResetPassword({
          serverUrl: SERVER_URL,
          email: "user@exemple.fr",
          code: "123456",
          password: "un mot de passe",
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining(NOT_ON_THE_PHONE),
      });
    }
  });
});
