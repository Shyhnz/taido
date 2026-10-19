// @vitest-environment node
/**
 * End to end (docs/SYNC.md § 9, integrator): the phone's backend and sync client against the
 * real server binary on 127.0.0.1. Skipped unless `TAIDO_SYNC_SERVER_BIN` points to a built
 * `taido-sync-server` (`pnpm test:e2e` builds it and sets it).
 *
 * V2.7 bis: attachment files between the phone (or the site) and a raw « Mac » client, both
 * ways, an upload cut then resumed after a reload, and an account full.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TaskRec } from "../lib/mock-backend";
import { ALREADY_LINKED } from "../lib/mock-sync";
import {
  type Change,
  changeKey,
  type FileStatus,
  type LoginResponse,
  PROTOCOL_VERSION,
  SETTING_INBOX_POSITION,
  type SyncResponse,
} from "../lib/sync-proto";
import { MobileBackend } from "./backend";
import { type FileStore, MemoryFileStore } from "./files";
import type { Persisted } from "./persisted";
import { MemoryStore } from "./store";
import type { FetchFn } from "./sync/client";
import {
  attachment,
  boardColumn,
  subject,
  task,
  timeSegment,
} from "./test/helpers";

const BIN = process.env.TAIDO_SYNC_SERVER_BIN;
const EMAIL = "user@example.com";
const PASSWORD = "un mot de passe assez long";

function env(
  dataDir: string,
  bind: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const {
    TAIDO_SYNC_STATIC_DIR: _ignored,
    TAIDO_MAX_FILE_BYTES: _max,
    TAIDO_ACCOUNT_QUOTA_BYTES: _quota,
    ...rest
  } = process.env;
  return {
    ...rest,
    TAIDO_SYNC_DATA_DIR: dataDir,
    TAIDO_SYNC_BIND: bind,
    RUST_LOG: "warn",
    ...extra,
  };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The Mac sends a whole file in one chunk (`PUT /api/files/{id}`). */
async function macPutFile(
  url: string,
  token: string,
  id: string,
  bytes: Uint8Array,
): Promise<FileStatus> {
  const q = new URLSearchParams({
    offset: "0",
    size: String(bytes.length),
    sha256: sha256(bytes),
  });
  const response = await fetch(`${url}/api/files/${id}?${q}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes as BodyInit,
  });
  if (!response.ok) throw new Error(`mac put: ${response.status}`);
  return (await response.json()) as FileStatus;
}

async function macFileStatus(
  url: string,
  token: string,
  id: string,
): Promise<FileStatus> {
  const response = await fetch(`${url}/api/files/${id}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`mac status: ${response.status}`);
  return (await response.json()) as FileStatus;
}

async function macDownload(
  url: string,
  token: string,
  id: string,
): Promise<Uint8Array> {
  const response = await fetch(`${url}/api/files/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`mac download: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Creates the test account on a running server (`POST /api/signup`). */
async function signup(url: string): Promise<void> {
  const response = await fetch(`${url}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: PROTOCOL_VERSION,
      email: EMAIL,
      password: PASSWORD,
      device_name: "Test",
    }),
  });
  if (!response.ok) throw new Error(`signup: ${response.status}`);
}

/** The Mac, as the server sees it: its own login and raw `POST /api/sync` (protocol 3). */
async function macLogin(url: string): Promise<string> {
  const response = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: PROTOCOL_VERSION,
      email: EMAIL,
      password: PASSWORD,
      device_name: "Mac",
    }),
  });
  if (!response.ok) throw new Error(`mac login: ${response.status}`);
  return ((await response.json()) as LoginResponse).token;
}

async function macSync(
  url: string,
  token: string,
  cursor: number,
  changes: Change[],
): Promise<SyncResponse> {
  const response = await fetch(`${url}/api/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ protocol: PROTOCOL_VERSION, cursor, changes }),
  });
  if (!response.ok) throw new Error(`mac sync: ${response.status}`);
  return (await response.json()) as SyncResponse;
}

interface Served {
  child: ChildProcess;
  url: string;
}

/** Starts `serve` and resolves with its address once it prints `LISTENING <addr>`. */
function serve(
  bin: string,
  dataDir: string,
  bind: string,
  extra: NodeJS.ProcessEnv = {},
): Promise<Served> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["serve"], {
      env: env(dataDir, bind, extra),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the server did not start"));
    }, 10_000);
    child.on("error", reject);
    if (!child.stdout) {
      reject(new Error("no stdout"));
      return;
    }
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = /^LISTENING (\S+)$/.exec(line.trim());
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: `http://${m[1]}` });
      }
    });
  });
}

function stop(served: Served): Promise<void> {
  return new Promise((resolve) => {
    if (served.child.exitCode !== null) {
      resolve();
      return;
    }
    served.child.once("exit", () => resolve());
    served.child.kill("SIGTERM");
  });
}

const phones: MobileBackend[] = [];

function phone(
  options: {
    store?: MemoryStore;
    persisted?: Persisted | null;
    fileStore?: FileStore;
    fetch?: FetchFn;
    chunkBytes?: number;
  } = {},
): MobileBackend {
  const backend = new MobileBackend({
    store: options.store ?? new MemoryStore(),
    persisted: options.persisted ?? null,
    fileStore: options.fileStore ?? new MemoryFileStore(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
  });
  phones.push(backend);
  return backend;
}

/** Pushes the rows, then lets the file job send what it can. */
async function syncAndSend(b: MobileBackend): Promise<void> {
  await b.engine.syncNow();
  await b.files.whenIdle();
}

async function newTask(b: MobileBackend, title: string) {
  return b.commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });
}

/** « Se connecter » in Réglages › Synchro (the command), then waits for the first run. */
async function link(backend: MobileBackend, url: string): Promise<void> {
  await backend.commands.syncLogin({
    serverUrl: url,
    email: EMAIL,
    password: PASSWORD,
  });
  await backend.commands.syncNow();
}

const byId = (b: MobileBackend, id: string): TaskRec | undefined =>
  b.state.tasks.find((t) => t.id === id);

/** The synced fields of every row, sorted: two devices in sync have equal dumps. */
function dump(b: MobileBackend): string[] {
  const rows: string[] = [];
  for (const s of b.state.subjects) {
    rows.push(
      JSON.stringify([
        "subject",
        s.id,
        s.name,
        s.color,
        s.parentId,
        s.position,
        s.createdAt,
        s.deletedAt,
        s.isGroup ?? false,
      ]),
    );
  }
  for (const s of b.state.sections) {
    rows.push(
      JSON.stringify([
        "section",
        s.id,
        s.subjectId,
        s.name,
        s.position,
        s.createdAt,
      ]),
    );
  }
  for (const t of b.state.tasks) {
    rows.push(
      JSON.stringify([
        "task",
        t.id,
        t.subjectId,
        t.sectionId,
        t.parentId,
        t.title,
        t.description,
        t.dueDate,
        t.dueTime,
        t.priority,
        t.completedAt,
        t.position,
        t.createdAt,
        t.deletedAt,
        t.boardColumnId ?? null,
      ]),
    );
  }
  for (const [key, value] of Object.entries(b.state.syncedSettings)) {
    rows.push(JSON.stringify(["setting", key, value]));
  }
  for (const g of b.notes.groups) {
    rows.push(
      JSON.stringify([
        "note_group",
        g.id,
        g.subjectId,
        g.name,
        g.position,
        g.createdAt,
      ]),
    );
  }
  for (const p of b.notes.pages) {
    rows.push(
      JSON.stringify([
        "note_page",
        p.id,
        p.subjectId,
        p.groupId,
        p.kind,
        p.title,
        p.body,
        p.sourceTaskId,
        p.pinnedAt,
        p.position,
        p.createdAt,
        p.deletedAt,
      ]),
    );
  }
  for (const a of b.links.attachments) {
    if (a.notePageId === undefined) continue;
    rows.push(
      JSON.stringify([
        "note_attachment",
        a.id,
        a.notePageId,
        a.fileName,
        a.mimeType,
        a.size,
        a.sha256 ?? null,
        a.addedAt,
        a.deletedAt,
      ]),
    );
  }
  return rows.sort();
}

async function converge(a: MobileBackend, b: MobileBackend): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await a.engine.syncNow();
    await b.engine.syncNow();
    if (a.pendingCount() === 0 && b.pendingCount() === 0) break;
  }
  await a.engine.syncNow();
  expect(a.pendingCount()).toBe(0);
  expect(b.pendingCount()).toBe(0);
  expect(dump(a)).toEqual(dump(b));
}

describe.skipIf(!BIN)("phone ↔ real sync server", () => {
  const bin = BIN ?? "";
  let dataDir = "";
  let served: Served;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "todo-sync-e2e-"));
    served = await serve(bin, dataDir, "127.0.0.1:0");
    await signup(served.url);
  });

  afterEach(() => {
    for (const p of phones.splice(0)) p.engine.stop();
  });

  afterAll(async () => {
    if (served) await stop(served);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("projects, sub-projects, tasks, notes, completion and deletes reach the other phone", async () => {
    const a = phone();
    const b = phone();
    const c = a.commands;
    const project = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    // Taido V2.2 bis: only a group holds projects (synced since protocol 3, V2.7).
    const group = await c.createSubject({
      name: "Clients",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const groupRec = a.state.subjects.find((s) => s.id === group.id);
    if (groupRec) groupRec.isGroup = true;
    const sub = await c.createSubject({
      name: "Site",
      color: null,
      rootPath: null,
      parentId: group.id,
    });
    const section = await c.createSection({
      subjectId: project.id,
      name: "Admin",
      subpath: null,
    });
    const invoice = await c.createTask({
      title: "Facturer",
      description: null,
      subjectId: project.id,
      sectionId: section.id,
      dueDate: "2026-10-12",
      dueTime: "17:00",
    });
    await c.updateTask({
      id: invoice.id,
      title: null,
      description: "Note du téléphone",
    });
    await c.setTaskPriority({ id: invoice.id, priority: 4 });
    const child = await c.addSubtask({ taskId: invoice.id, text: "Relancer" });
    const mockup = await c.createTask({
      title: "Maquette",
      description: null,
      subjectId: sub.id,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const doomed = await c.createTask({
      title: "À supprimer",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });

    await link(a, served.url);
    expect((await c.syncStatus()).state).toBe("idle");
    expect(a.pendingCount()).toBe(0);
    await link(b, served.url);
    await converge(a, b);

    expect(byId(b, invoice.id)?.description).toBe("Note du téléphone");
    expect(byId(b, invoice.id)?.priority).toBe(4);
    expect(byId(b, child.id)?.parentId).toBe(invoice.id);
    expect(byId(b, mockup.id)?.subjectId).toBe(sub.id);
    expect(b.state.subjects.find((s) => s.id === sub.id)?.parentId).toBe(
      group.id,
    );
    expect(b.state.subjects.find((s) => s.id === group.id)?.isGroup).toBe(true);

    // B completes, A deletes: both see both.
    await b.commands.setTaskCompleted({ id: invoice.id, completed: true });
    await c.deleteTask(doomed.id);
    await converge(a, b);
    expect(byId(a, invoice.id)?.completedAt).not.toBeNull();
    expect(byId(b, doomed.id)?.deletedAt).not.toBeNull();

    // A section deleted on B: the task stays, without section, on A.
    await b.commands.deleteSection(section.id);
    await converge(a, b);
    expect(a.state.sections.some((s) => s.id === section.id)).toBe(false);
    expect(byId(a, invoice.id)?.sectionId).toBeNull();
  });

  it("« Sans projet »'s position reaches the other phone, last writer wins", async () => {
    const a = phone();
    const b = phone();
    const names = ["Alpha", "Beta", "Gamma"];
    for (const name of names) {
      await a.commands.createSubject({
        name,
        color: null,
        rootPath: null,
        parentId: null,
      });
    }
    await a.commands.createTask({
      title: "Sans projet",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await link(a, served.url);
    await link(b, served.url);
    await converge(a, b);
    // Never moved: last on both (the server keeps the earlier tests' projects), and no
    // setting sent.
    const tops = b.state.subjects.filter(
      (s) => s.parentId === null && s.deletedAt === null,
    );
    expect(tops.length).toBeGreaterThanOrEqual(3);
    expect(await b.commands.getInboxIndex()).toBe(tops.length);
    expect(b.state.syncedSettings).toEqual({});

    await a.commands.reorderInbox(1);
    await converge(a, b);
    expect(b.state.syncedSettings[SETTING_INBOX_POSITION]).toBe(
      a.state.syncedSettings[SETTING_INBOX_POSITION],
    );
    expect(await b.commands.getInboxIndex()).toBe(1);
    const allView = (p: MobileBackend) =>
      p.commands.getView({
        kind: "all",
        subjectId: null,
        from: null,
        days: null,
      });
    const noProject = (await allView(b)).groups.find(
      (g) => g.key.type === "no_project",
    );
    expect(noProject?.order).toEqual({ parentId: null, index: 1 });

    // B moves it first (stamped after the known version): A follows.
    await b.commands.reorderInbox(0);
    await converge(a, b);
    expect(await a.commands.getInboxIndex()).toBe(0);
  });

  it("replays the offline queue when the server comes back", async () => {
    const a = phone();
    const b = phone();
    const t = await a.commands.createTask({
      title: "Avant la coupure",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await link(a, served.url);
    await link(b, served.url);
    await converge(a, b);

    const addr = served.url.replace("http://", "");
    await stop(served);
    await a.commands.updateTask({
      id: t.id,
      title: "Modifiée hors ligne",
      description: null,
    });
    const offline = await a.commands.createTask({
      title: "Créée hors ligne",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const status = await a.engine.syncNow();
    expect(status.state).toBe("offline");
    expect(status.pending).toBe(2);

    served = await serve(bin, dataDir, addr);
    expect(served.url).toBe(`http://${addr}`);
    const back = await a.engine.syncNow();
    expect(back.state).toBe("idle");
    expect(back.pending).toBe(0);
    await converge(a, b);
    expect(byId(b, t.id)?.title).toBe("Modifiée hors ligne");
    expect(byId(b, offline.id)?.title).toBe("Créée hors ligne");
  });

  it("review points 1–3 and 5: the Mac's board, time and group on the phone, a card moved both ways, manual time and a relation sent, a running Mac segment untouched", async () => {
    const S = "2026-10-01T08:00:00.000Z";
    const ENDED = "2026-10-01T08:30:00.000Z";
    const token = await macLogin(served.url);
    const pushed = await macSync(served.url, token, 0, [
      subject("e2e-grp", S, { name: "Clients Mac", is_group: true }),
      subject("e2e-proj", S, { name: "Site Mac", parent_id: "e2e-grp" }),
      ...["À faire", "En cours", "À valider", "Terminé"].map((name, i) =>
        boardColumn(`col-e2e-proj-${i}`, "e2e-proj", S, {
          name,
          position: i,
          is_done: i === 3,
        }),
      ),
      task("e2e-other", S, { subject_id: "e2e-proj", title: "Autre" }),
      task("e2e-task", S, {
        subject_id: "e2e-proj",
        title: "Relire",
        board_column_id: "col-e2e-proj-2",
      }),
      timeSegment("e2e-seg-1", "e2e-task", S, { ended_at: ENDED }),
      timeSegment("e2e-seg-2", "e2e-task", ENDED),
    ]);
    expect(pushed.rejected).toEqual([]);
    expect(pushed.accepted).toBe(10);

    const p = phone();
    await link(p, served.url);
    expect(await p.commands.syncStatus()).toMatchObject({
      state: "idle",
      errorKind: null,
      pending: 0,
    });
    expect(await p.commands.syncAccount()).toEqual({
      email: EMAIL,
      emailVerified: true,
    });
    expect(p.state.subjects.find((s) => s.id === "e2e-grp")?.isGroup).toBe(
      true,
    );
    expect(byId(p, "e2e-task")?.boardColumnId).toBe("col-e2e-proj-2");
    expect(p.parked).toEqual({});
    // V2.8: the Mac's board and time are on the phone, the running segment shown running.
    const board = await p.commands.getBoard("e2e-proj");
    expect(board.columns.map((c) => [c.id, c.total])).toEqual([
      ["col-e2e-proj-0", 1],
      ["col-e2e-proj-1", 0],
      ["col-e2e-proj-2", 1],
      ["col-e2e-proj-3", 0],
    ]);
    expect((await p.commands.getTask("e2e-task")).time.chrono).toEqual({
      seconds: 1800,
      runningSince: ENDED,
    });
    expect(p.chrono.segments.map((x) => x.agentSessionId)).toEqual([
      null,
      null,
    ]);

    await p.commands.updateTask({
      id: "e2e-task",
      title: "Relire v2",
      description: null,
    });
    await p.commands.updateSubject({
      id: "e2e-grp",
      name: "Clients",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(await p.commands.syncNow()).toMatchObject({
      state: "idle",
      pending: 0,
    });

    // The Mac's next sync gets exactly the two renamed rows, column and group kept.
    const pulled = await macSync(served.url, token, pushed.cursor, []);
    const rows = new Map(pulled.changes.map((c) => [changeKey(c), c]));
    expect([...rows.keys()].sort()).toEqual([
      "subject:e2e-grp",
      "task:e2e-task",
    ]);
    expect(rows.get("task:e2e-task")?.data).toMatchObject({
      title: "Relire v2",
      board_column_id: "col-e2e-proj-2",
    });
    expect(rows.get("subject:e2e-grp")?.data).toMatchObject({
      name: "Clients",
      is_group: true,
    });

    // The phone moves the card, checks and reopens the task, adds time by hand and a relation.
    await p.commands.moveTaskToColumn({
      taskId: "e2e-task",
      columnId: "col-e2e-proj-1",
    });
    await p.commands.setTaskCompleted({ id: "e2e-task", completed: true });
    await p.commands.setTaskCompleted({ id: "e2e-task", completed: false });
    await p.commands.addManualTime({
      taskId: "e2e-task",
      minutes: 20,
      note: "Relecture",
    });
    await p.commands.addRelation({
      taskId: "e2e-task",
      otherId: "e2e-other",
      kind: "blocks",
    });
    expect(await p.commands.syncNow()).toMatchObject({
      state: "idle",
      pending: 0,
    });
    const moved = await macSync(served.url, token, pulled.cursor, []);
    const got = new Map(moved.changes.map((c) => [changeKey(c), c]));
    const manual = p.chrono.segments.find((x) => x.source === "manual");
    const rel = p.links.relations[0];
    expect([...got.keys()].sort()).toEqual(
      [
        "task:e2e-task",
        `time_segment:${manual?.id}`,
        `relation:${rel.id}`,
      ].sort(),
    );
    expect(got.get("task:e2e-task")?.data).toMatchObject({
      board_column_id: "col-e2e-proj-1",
      completed_at: null,
    });
    expect(got.get(`time_segment:${manual?.id}`)?.data).toMatchObject({
      task_id: "e2e-task",
      source: "manual",
      note: "Relecture",
    });
    expect(got.get(`relation:${rel.id}`)?.data).toMatchObject({
      from_task_id: "e2e-task",
      to_task_id: "e2e-other",
      kind: "blocks",
    });

    // The Mac moves the card to « À valider »: the phone follows. Its segment still runs.
    const MOVED = new Date(Date.now() + 60_000).toISOString();
    const back = await macSync(served.url, token, moved.cursor, [
      task("e2e-task", MOVED, {
        subject_id: "e2e-proj",
        title: "Relire v2",
        board_column_id: "col-e2e-proj-2",
      }),
    ]);
    expect(back.accepted).toBe(1);
    await p.commands.syncNow();
    expect(byId(p, "e2e-task")?.boardColumnId).toBe("col-e2e-proj-2");
    expect(p.chrono.segments.find((x) => x.id === "e2e-seg-2")).toMatchObject({
      endedAt: null,
      deletedAt: null,
    });

    // Review point 2: a second phone, both making « Sans projet »'s board: one set of four.
    const q = phone();
    await link(q, served.url);
    expect(
      (await q.commands.getBoard("e2e-proj")).columns.map((c) => c.id),
    ).toEqual([0, 1, 2, 3].map((i) => `col-e2e-proj-${i}`));
    await p.commands.getBoard(null);
    await q.commands.getBoard(null);
    await converge(p, q);
    const all = await macSync(served.url, token, 0, []);
    const columns = all.changes
      .filter((c) => c.entity === "board_column")
      .map((c) => c.id)
      .sort();
    expect(columns).toEqual(
      [
        ...[0, 1, 2, 3].map((i) => `col-e2e-proj-${i}`),
        ...[0, 1, 2, 3].map((i) => `col-inbox-${i}`),
      ].sort(),
    );
    expect(q.board.columns).toHaveLength(8);

    // Review point 5: the Mac deletes the task for good: its segments and relation go too.
    const gone = await macSync(served.url, token, all.cursor, [
      {
        entity: "task",
        id: "e2e-task",
        updated_at: new Date(Date.now() + 120_000).toISOString(),
        device_id: "mac",
        data: null,
      },
    ]);
    expect(gone.accepted).toBe(1);
    await converge(p, q);
    for (const b of [p, q]) {
      expect(b.chrono.segments.filter((x) => x.taskId === "e2e-task")).toEqual(
        [],
      );
      expect(b.links.relations).toEqual([]);
    }
  });

  it("« Arrêter » on the phone stops a Mac's running segment; the Mac gets the stop and runs a new one", async () => {
    const S = new Date(Date.now() - 10 * 60_000).toISOString();
    const token = await macLogin(served.url);
    const pushed = await macSync(served.url, token, 0, [
      task("e2e-stop", S, { title: "Chrono perdu" }),
      timeSegment("e2e-stuck", "e2e-stop", S),
    ]);
    expect(pushed.rejected).toEqual([]);
    const p = phone();
    await link(p, served.url);
    expect(
      (await p.commands.getTask("e2e-stop")).time.chrono.runningSince,
    ).toBe(S);

    const stopped = await p.commands.stopTimeSegment("e2e-stuck");
    expect(stopped.time.chrono.runningSince).toBeNull();
    expect(await p.commands.syncNow()).toMatchObject({
      state: "idle",
      pending: 0,
    });
    const ended = p.chrono.segments.find((x) => x.id === "e2e-stuck")?.endedAt;
    expect(ended).not.toBeNull();

    // The Mac pulls the stop: ended, no reason (the server accepted `stop_reason: null`).
    const pulled = await macSync(served.url, token, pushed.cursor, []);
    const row = pulled.changes.find((c) => c.id === "e2e-stuck");
    expect(row?.device_id).not.toBe("mac");
    expect(row?.data).toMatchObject({ ended_at: ended, stop_reason: null });

    // Claude's next turn on the Mac: a new running segment, beside the stopped one.
    const NEXT = new Date(Date.now() + 60_000).toISOString();
    const next = await macSync(served.url, token, pulled.cursor, [
      timeSegment("e2e-next", "e2e-stop", NEXT),
    ]);
    expect(next.rejected).toEqual([]);
    await p.commands.syncNow();
    const time = (await p.commands.getTask("e2e-stop")).time;
    expect(time.chrono.runningSince).toBe(NEXT);
    expect(time.segments.map((x) => [x.id, x.endedAt === null])).toEqual([
      ["e2e-next", true],
      ["e2e-stuck", false],
    ]);
  });

  it("login errors and the account, on the real server", async () => {
    const p = phone();
    await expect(
      p.commands.syncLogin({
        serverUrl: served.url,
        email: EMAIL,
        password: "pas le bon mot de passe",
      }),
    ).rejects.toMatchObject({ kind: "sync_auth" });
    await expect(
      p.commands.syncLogin({
        serverUrl: served.url,
        email: "inconnu@example.com",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ kind: "sync_auth" });
    expect(await p.commands.syncAccount()).toBeNull();

    await link(p, served.url);
    expect((await p.commands.syncAccount())?.email).toBe(EMAIL);
    await expect(
      p.commands.syncLogin({
        serverUrl: served.url,
        email: "autre@example.com",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringContaining(ALREADY_LINKED),
    });
    await p.commands.syncUnlink();
    expect(await p.commands.syncAccount()).toBeNull();

    // Ten wrong passwords for one address: the next try is rate limited.
    const limited = "bloque@example.com";
    for (let i = 0; i < 10; i += 1) {
      await expect(
        p.commands.syncLogin({
          serverUrl: served.url,
          email: limited,
          password: "faux",
        }),
      ).rejects.toMatchObject({ kind: "sync_auth" });
    }
    await expect(
      p.commands.syncLogin({
        serverUrl: served.url,
        email: limited,
        password: "faux",
      }),
    ).rejects.toMatchObject({ kind: "sync_rate_limited" });
  });
  it("the notebook: a page made on a phone reaches the server and comes back identical on a second phone, image included", async () => {
    const a = phone({ chunkBytes: 64 * 1024 });
    const b = phone();
    const c = a.commands;
    const project = await c.createSubject({
      name: "Notes e2e",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const group = await c.createNoteGroup({
      subjectId: project.id,
      name: "Décisions",
    });
    const made = await c.createNotePage({
      subjectId: project.id,
      groupId: group.id,
      title: "Style des mails",
      body: "Style « Bleu nuit » ==surligné==",
      kind: "page",
      sourceTaskId: null,
    });
    const pinned = await c.createNotePage({
      subjectId: project.id,
      groupId: null,
      title: "Serveur et accès",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    await c.moveNotePage({ id: pinned.id, target: "pinned", index: null });
    const bytes = new Uint8Array(randomBytes(100_000));
    const { ids } = await a.files.addToPage(made.id, [
      new File([bytes as BlobPart], "maquette.png", { type: "image/png" }),
    ]);
    await c.updateNotePage({
      id: made.id,
      title: null,
      body: `Style « Bleu nuit » ==surligné==\n\n![[file:${ids[0]}|50%]]`,
    });
    await link(a, served.url);
    await a.files.whenIdle();
    expect(a.pendingCount()).toBe(0);
    await link(b, served.url);
    await converge(a, b);
    // The second phone holds the same notebook, with the same order and pin.
    const view = await b.commands.notebook(project.id);
    expect(view.pinned.map((r) => r.title)).toEqual(["Serveur et accès"]);
    expect(
      view.groups.map((g) => [g.group.name, g.pages.map((r) => r.title)]),
    ).toEqual([["Décisions", ["Style des mails"]]]);
    expect((await b.commands.getNotePage(made.id)).body).toContain(
      `![[file:${ids[0]}|50%]]`,
    );
    // The image row is a note_attachment on the server, and its file downloads on the 2nd phone.
    const [image] = await b.commands.listNoteAttachments(made.id);
    expect(image).toMatchObject({
      id: ids[0],
      fileName: "maquette.png",
      isImage: true,
    });
    const opened = await b.files.open(ids[0]);
    expect(sha256(new Uint8Array(await opened.blob.arrayBuffer()))).toBe(
      sha256(bytes),
    );
    // A page deleted and a group removed on the second phone reach the first.
    await b.commands.deleteNotePage(pinned.id);
    await b.commands.deleteNoteGroup(group.id);
    await converge(a, b);
    const after = await a.commands.notebook(project.id);
    expect(after.groups).toEqual([]);
    expect(after.pinned).toEqual([]);
    expect(after.ungrouped.map((r) => r.title)).toEqual(["Style des mails"]);
  });

  it("the notebook: a client that does not declare it is not sent its rows; the phone's pull of an old account starts again from 0 once", async () => {
    const token = await macLogin(served.url);
    // The raw client above declares nothing: the legacy entities only.
    const pulled = await macSync(served.url, token, 0, []);
    expect(pulled.changes.filter((c) => c.entity.startsWith("note_"))).toEqual(
      [],
    );
    // A phone that declares everything (this build) is sent them.
    const p = phone();
    await link(p, served.url);
    expect(p.notes.pages.length).toBeGreaterThan(0);
    // The cursor goes back to 0 once when the declared list grows.
    const cursor = p.syncData.cursor;
    p.syncData.knownEntities = [];
    p.notes.pages = [];
    p.notes.groups = [];
    for (const k of Object.keys(p.snapshot)) {
      if (k.startsWith("note_")) delete p.snapshot[k];
    }
    p.links.attachments = p.links.attachments.filter(
      (a) => a.notePageId === undefined,
    );
    p.syncData.cursor = cursor;
    await p.engine.syncNow();
    expect(p.notes.pages.length).toBeGreaterThan(0);
    expect(p.pendingCount()).toBe(0);
  });

  it("V2.7 bis: a file added on the phone reaches the server, the Mac downloads the same bytes", async () => {
    const p = phone({ chunkBytes: 64 * 1024 });
    await link(p, served.url);
    const t = await newTask(p, "Rapport du téléphone");
    const bytes = new Uint8Array(randomBytes(200_000));
    await p.files.add(t.id, [
      new File([bytes as BlobPart], "rapport.pdf", { type: "application/pdf" }),
    ]);
    await syncAndSend(p);
    const [a] = (await p.commands.getTask(t.id)).attachments;
    expect(a.remote).toBe("none");
    // Sent: the copy kept on the phone is dropped.
    expect(await p.files.store.get(a.id)).toBeNull();

    const token = await macLogin(served.url);
    const pulled = await macSync(served.url, token, 0, []);
    const row = pulled.changes.find(
      (c) => c.entity === "attachment" && c.id === a.id,
    );
    expect(row?.data).toMatchObject({
      task_id: t.id,
      file_name: "rapport.pdf",
      mime_type: "application/pdf",
      size: bytes.length,
      sha256: sha256(bytes),
    });
    const got = await macDownload(served.url, token, a.id);
    expect(got.length).toBe(bytes.length);
    expect(sha256(got)).toBe(sha256(bytes));
  });

  it("V2.7 bis: a file the Mac sent is downloaded by the phone; HTML and PNG both saved", async () => {
    const S = "2026-10-02T08:00:00.000Z";
    const html = new TextEncoder().encode(
      "<!doctype html><script>fetch('/api/sync')</script>",
    );
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72,
    ]);
    const token = await macLogin(served.url);
    const pushed = await macSync(served.url, token, 0, [
      task("e2e-files-task", S, { title: "Fichiers du Mac" }),
      attachment("e2e-att-html", "e2e-files-task", S, {
        file_name: "page.html",
        mime_type: "text/html",
        size: html.length,
        sha256: sha256(html),
      }),
      attachment("e2e-att-png", "e2e-files-task", S, {
        file_name: "capture.png",
        mime_type: "image/png",
        size: png.length,
        sha256: sha256(png),
      }),
    ]);
    expect(pushed.rejected).toEqual([]);
    expect(
      (await macPutFile(served.url, token, "e2e-att-html", html)).complete,
    ).toBe(true);
    expect(
      (await macPutFile(served.url, token, "e2e-att-png", png)).complete,
    ).toBe(true);

    const p = phone();
    await link(p, served.url);
    const tiles = (await p.commands.getTask("e2e-files-task")).attachments;
    expect(tiles.map((x) => [x.fileName, x.remote])).toEqual([
      ["page.html", "none"],
      ["capture.png", "none"],
    ]);
    const page = await p.files.open("e2e-att-html");
    expect(page.blob.type).toBe("application/octet-stream");
    expect(sha256(new Uint8Array(await page.blob.arrayBuffer()))).toBe(
      sha256(html),
    );
    const image = await p.files.open("e2e-att-png");
    expect(image.blob.type).toBe("application/octet-stream");
    expect(sha256(new Uint8Array(await image.blob.arrayBuffer()))).toBe(
      sha256(png),
    );
  });

  it("V2.7 bis: an upload cut midway goes on after a reload from the bytes the server holds", async () => {
    const chunk = 64 * 1024;
    let puts = 0;
    let cut = true;
    const cutting: FetchFn = (input, init) => {
      if (init.method === "PUT" && cut) {
        puts += 1;
        // The probe, the first chunk, then the network goes.
        if (puts === 3) return Promise.reject(new TypeError("Failed to fetch"));
      }
      return fetch(input, init);
    };
    const store = new MemoryStore();
    const fileStore = new MemoryFileStore();
    const p = phone({ store, fileStore, fetch: cutting, chunkBytes: chunk });
    await link(p, served.url);
    const t = await newTask(p, "Envoi coupé");
    const bytes = new Uint8Array(randomBytes(3 * chunk + 1000));
    await p.files.add(t.id, [new File([bytes as BlobPart], "film.mov")]);
    await syncAndSend(p);
    const [a] = (await p.commands.getTask(t.id)).attachments;
    expect(a.remote).toBe("local_only");
    const token = await macLogin(served.url);
    expect(await macFileStatus(served.url, token, a.id)).toMatchObject({
      received: chunk,
      complete: false,
    });

    // The page is reloaded with the network back.
    cut = false;
    await p.saveNow();
    p.engine.stop();
    const offsets: number[] = [];
    const watching: FetchFn = (input, init) => {
      if (init.method === "PUT") {
        offsets.push(Number(new URL(input).searchParams.get("offset")));
      }
      return fetch(input, init);
    };
    const again = phone({
      persisted: await store.load(),
      fileStore,
      fetch: watching,
      chunkBytes: chunk,
    });
    await syncAndSend(again);
    expect(offsets).toEqual([chunk, 2 * chunk, 3 * chunk]);
    expect((await again.commands.getTask(t.id)).attachments[0].remote).toBe(
      "none",
    );
    const got = await macDownload(served.url, token, a.id);
    expect(sha256(got)).toBe(sha256(bytes));
  });

  it("V2.7 bis: an account full says so on the tile, and the tasks keep syncing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-sync-e2e-quota-"));
    const small = await serve(bin, dir, "127.0.0.1:0", {
      TAIDO_ACCOUNT_QUOTA_BYTES: "1000",
    });
    try {
      await signup(small.url);
      const p = phone();
      await link(p, small.url);
      const t = await newTask(p, "Trop pour le compte");
      await p.files.add(t.id, [
        new File([new Uint8Array(2000) as BlobPart], "gros.bin"),
      ]);
      await syncAndSend(p);
      expect((await p.commands.getTask(t.id)).attachments[0].remote).toBe(
        "quota_full",
      );
      const later = await newTask(p, "Créée après");
      await syncAndSend(p);
      expect(await p.commands.syncStatus()).toMatchObject({
        state: "idle",
        pending: 0,
      });
      const token = await macLogin(small.url);
      const pulled = await macSync(small.url, token, 0, []);
      expect(pulled.changes.some((c) => c.id === later.id)).toBe(true);
      expect((await p.commands.getTask(t.id)).attachments[0].remote).toBe(
        "quota_full",
      );
    } finally {
      await stop(small);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
