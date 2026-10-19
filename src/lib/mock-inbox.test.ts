/**
 * « Sans projet » movable: the mock mirrors core
 * `db/top_level.rs` and `views::all_view` with the same cases and expectations, so both
 * backends agree on the top-level order, `getInboxIndex`, `reorderInbox`, `reorderSubject`
 * at the top level, and where « À faire » puts the « Sans projet » group.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { CreateTaskInput, DataChanged } from "../bindings";
import { MockBackend, type SubjectRec } from "./mock-backend";
import { SETTING_INBOX_POSITION } from "./sync-proto";

const NOW = new Date(2026, 9, 4, 10, 0);

let backend: MockBackend;
const c = () => backend.commands;

/** A top-level project with a given position (like the core tests' `insert`). */
function insert(id: string, position: number, parentId: string | null = null) {
  const rec: SubjectRec = {
    id,
    name: id,
    color: "violet",
    rootPath: null,
    parentId,
    position,
    createdAt: "x",
    updatedAt: "x",
    deletedAt: null,
  };
  backend.state.subjects.push(rec);
  return rec;
}

const rec = (id: string) => {
  const s = backend.state.subjects.find((x) => x.id === id);
  if (!s) throw new Error(`no subject ${id}`);
  return s;
};

const setInbox = (position: number) => {
  backend.state.syncedSettings[SETTING_INBOX_POSITION] = position;
};

const inbox = () => backend.inboxPosition();

/** The order as short names: subject ids, `*` for « Sans projet ». */
const names = () =>
  backend.topLevelOrder().map((i) => (i.kind === "inbox" ? "*" : i.rec.id));

const reorder = (id: string, index: number) =>
  c().reorderSubject({ id, index });

function abc() {
  insert("a", 1);
  insert("b", 2);
  insert("c", 3);
}

beforeEach(() => {
  backend = new MockBackend({ now: () => NOW, seed: false });
});

describe("top-level order (core top_level)", () => {
  it("puts an unset inbox last", async () => {
    expect(names()).toEqual(["*"]);
    expect(await c().getInboxIndex()).toBe(0);
    abc();
    expect(names()).toEqual(["a", "b", "c", "*"]);
    expect(await c().getInboxIndex()).toBe(3);
  });

  it("sorts a set inbox by position, after ties", async () => {
    abc();
    const cases: [number, string[], number][] = [
      [0.5, ["*", "a", "b", "c"], 0],
      [1, ["a", "*", "b", "c"], 1],
      [1.5, ["a", "*", "b", "c"], 1],
      [2, ["a", "b", "*", "c"], 2],
      [3, ["a", "b", "c", "*"], 3],
      [9, ["a", "b", "c", "*"], 3],
    ];
    for (const [position, expected, index] of cases) {
      setInbox(position);
      expect(names()).toEqual(expected);
      expect(await c().getInboxIndex()).toBe(index);
    }
  });

  it("reads a stored value that is not a finite number as unset", () => {
    abc();
    backend.state.syncedSettings[SETTING_INBOX_POSITION] = "2";
    expect(inbox()).toBeNull();
    expect(names()).toEqual(["a", "b", "c", "*"]);
  });

  it("ignores soft-deleted projects and sub-projects", async () => {
    abc();
    insert("a1", 0.1, "a");
    rec("b").deletedAt = "x";
    setInbox(2.5);
    expect(names()).toEqual(["a", "*", "c"]);
    expect(await c().getInboxIndex()).toBe(1);
  });

  it("appends after deleted projects and the placed inbox", async () => {
    abc();
    rec("c").deletedAt = "x";
    insert("a1", 50, "a");
    setInbox(7.5);
    const d = await c().createSubject({
      name: "d",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(rec(d.id).position).toBe(8.5);
    setInbox(0.5);
    const e = await c().createSubject({
      name: "e",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(rec(e.id).position).toBe(9.5);
  });

  it("gives the first project of an empty level position 1, a placed inbox counted", async () => {
    setInbox(4);
    const d = await c().createSubject({
      name: "d",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(rec(d.id).position).toBe(5);
  });
});

describe("reorder at the top level (core top_level::reorder)", () => {
  it("moves a project before or onto an unset inbox without writing it", async () => {
    abc();
    // a to the slot of the unset inbox (index 2 among b, c, *): last project.
    await reorder("a", 2);
    expect(names()).toEqual(["b", "c", "a", "*"]);
    expect(inbox()).toBeNull();
    await reorder("a", 0);
    expect(names()).toEqual(["a", "b", "c", "*"]);
    await reorder("c", 1);
    expect(names()).toEqual(["a", "c", "b", "*"]);
    expect(inbox()).toBeNull();
    expect(backend.state.syncedSettings).toEqual({});
  });

  it("places the inbox when a project is dropped past it", async () => {
    abc();
    await reorder("a", 3);
    expect(names()).toEqual(["b", "c", "*", "a"]);
    expect(inbox()).toBe(4);
    // From then on a new project goes after everything, the inbox included.
    const d = await c().createSubject({
      name: "d",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(names()).toEqual(["b", "c", "*", "a", d.id]);
  });

  it("lands a new project before an unset inbox", async () => {
    abc();
    const d = await c().createSubject({
      name: "d",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(names()).toEqual(["a", "b", "c", d.id, "*"]);
    expect(inbox()).toBeNull();
  });

  it("moves the inbox first, in the middle and last", async () => {
    abc();
    await c().reorderInbox(0);
    expect(names()).toEqual(["*", "a", "b", "c"]);
    expect(inbox()).toBe(0);
    await c().reorderInbox(2);
    expect(names()).toEqual(["a", "b", "*", "c"]);
    expect(inbox()).toBe(2.5);
    await c().reorderInbox(3);
    expect(names()).toEqual(["a", "b", "c", "*"]);
    expect(inbox()).toBe(4);
    await c().reorderInbox(99);
    expect(names()).toEqual(["a", "b", "c", "*"]);
    expect(await c().getInboxIndex()).toBe(3);
  });

  it("moves a project around a placed inbox", async () => {
    abc();
    await c().reorderInbox(1);
    expect(names()).toEqual(["a", "*", "b", "c"]);
    await reorder("c", 1);
    expect(names()).toEqual(["a", "c", "*", "b"]);
    await reorder("a", 3);
    expect(names()).toEqual(["c", "*", "b", "a"]);
    await reorder("a", 0);
    expect(names()).toEqual(["a", "c", "*", "b"]);
  });

  it("renumbers projects and inbox together when the gap is too small", async () => {
    insert("a", 1);
    insert("b", 1 + 1e-9);
    const gone = insert("gone", 1 + 2e-9);
    gone.deletedAt = "x";
    insert("c", 7);
    // Tie with b: the inbox sorts after it.
    setInbox(1 + 1e-9);
    expect(names()).toEqual(["a", "b", "*", "c"]);
    await reorder("c", 1);
    expect(names()).toEqual(["a", "c", "b", "*"]);
    // Renumbered a=1, b=2, inbox=3, gone=4, c=5, then c moved to 1.5.
    const positions = [...backend.state.subjects]
      .sort((x, y) => x.position - y.position)
      .map((s) => [s.id, s.position]);
    expect(positions).toEqual([
      ["a", 1],
      ["c", 1.5],
      ["b", 2],
      ["gone", 4],
    ]);
    expect(inbox()).toBe(3);
  });

  it("refuses a deleted or missing project", async () => {
    abc();
    rec("b").deletedAt = "x";
    await expect(reorder("b", 0)).rejects.toMatchObject({ kind: "not_found" });
    await expect(reorder("missing", 0)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("counts the inbox at the top level only", async () => {
    abc();
    insert("a1", 1, "a");
    insert("a2", 2, "a");
    await c().reorderInbox(1);
    // Index 2 of [a, *, c] (b moving): after the inbox.
    await reorder("b", 2);
    expect(names()).toEqual(["a", "*", "b", "c"]);
    // Sub-projects: among their siblings, the inbox does not count.
    await reorder("a2", 0);
    const subs = (await c().listSubjects())
      .filter((s) => s.parentId === "a")
      .map((s) => s.id);
    expect(subs).toEqual(["a2", "a1"]);
  });

  it("notifies projects and tasks", async () => {
    abc();
    const scopes: DataChanged["scopes"][] = [];
    await backend.events.dataChanged.listen((e) =>
      scopes.push(e.payload.scopes),
    );
    await c().reorderInbox(0);
    await reorder("a", 0);
    expect(scopes).toEqual([
      ["subjects", "tasks"],
      ["subjects", "tasks"],
    ]);
  });

  it("puts a project moved or restored to the top level after a placed inbox", async () => {
    abc();
    await c().reorderInbox(3);
    // Taido V2.2 bis: only a group holds projects.
    const a = backend.state.subjects.find((s) => s.id === "a");
    if (a) a.isGroup = true;
    const sub = await c().createSubject({
      name: "sub",
      color: null,
      rootPath: null,
      parentId: "a",
    });
    await c().updateSubject({
      id: sub.id,
      name: null,
      color: null,
      rootPath: null,
      parentId: "",
    });
    expect(names()).toEqual(["a", "b", "c", "*", sub.id]);
  });
});

describe("« À faire » (core all_view)", () => {
  const task = (title: string, subjectId: string | null) =>
    c().createTask({
      title,
      description: null,
      subjectId,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    } satisfies CreateTaskInput);

  const project = async (name: string, parentId: string | null = null) => {
    // Taido V2.2 bis: only a group holds projects.
    const parent = backend.state.subjects.find((s) => s.id === parentId);
    if (parent) parent.isGroup = true;
    return (
      await c().createSubject({ name, color: null, rootPath: null, parentId })
    ).id;
  };

  /** [first title, parent, index] of every group. */
  const groups = async () =>
    (
      await c().getView({
        kind: "all",
        subjectId: null,
        from: null,
        days: null,
      })
    ).groups.map((g) => [
      g.tasks[0].title,
      g.order?.parentId ?? null,
      g.order?.index ?? null,
    ]);

  it("places « Sans projet » at its index and orders every group", async () => {
    // Taido V2.2 bis: Globex and Perso are groups (no tasks of their own).
    const globex = await project("Globex");
    await project("Empty");
    const perso = await project("Perso");
    const client = await project("Client", globex);
    const quiet = await project("Quiet", globex);
    const other = await project("Other", perso);
    await task("c1", client);
    await task("q1", quiet);
    await task("o1", other);
    const loose = await task("i1", null);

    // Default: last, after every top-level item (Empty counts, it has no group).
    expect(await groups()).toEqual([
      ["c1", globex, 0],
      ["q1", globex, 1],
      ["o1", perso, 0],
      ["i1", null, 3],
    ]);
    // First.
    await c().reorderInbox(0);
    expect(await groups()).toEqual([
      ["i1", null, 0],
      ["c1", globex, 0],
      ["q1", globex, 1],
      ["o1", perso, 0],
    ]);
    // After Globex: after its projects too.
    await c().reorderInbox(1);
    expect(await groups()).toEqual([
      ["c1", globex, 0],
      ["q1", globex, 1],
      ["i1", null, 1],
      ["o1", perso, 0],
    ]);
    // After Empty (no group): right before Perso's projects.
    await c().reorderInbox(2);
    const listed = await groups();
    expect(listed[2]).toEqual(["i1", null, 2]);
    expect(listed[3]).toEqual(["o1", perso, 0]);
    expect(await c().getInboxIndex()).toBe(2);

    // Hidden (no open task): no group, its slot still counts.
    await c().deleteTask(loose.id);
    expect(await groups()).toEqual([
      ["c1", globex, 0],
      ["q1", globex, 1],
      ["o1", perso, 0],
    ]);
  });

  it("sets no order in the other views", async () => {
    const globex = await project("Globex");
    await task("t", globex);
    await task("i", null);
    for (const kind of ["inbox", "today", "upcoming"] as const) {
      const view = await c().getView({
        kind,
        subjectId: null,
        from: null,
        days: null,
      });
      expect(view.groups.every((g) => g.order == null)).toBe(true);
    }
    const view = await c().getView({
      kind: "subject",
      subjectId: globex,
      from: null,
      days: null,
    });
    expect(view.groups.every((g) => g.order == null)).toBe(true);
  });
});
