import type { DragEndEvent } from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteTarget, TaskGroup } from "../../bindings";
import { commands, mockBackend } from "../../lib/ipc";
import {
  type DragData,
  dropIndex,
  handleDragEnd,
  notePageAccepts,
  type Place,
  type PlacedRow,
} from "./DndProvider";

type TaskDrag = Extract<DragData, { type: "task" }>;
type GroupDrag = Extract<DragData, { type: "project_group" }>;

const node = (id: string, data: DragData) => ({
  id,
  data: { current: data },
  rect: { current: { initial: null, translated: null } },
});

const event = (from: DragData, to: DragData, delta = { x: 0, y: 40 }) =>
  ({
    active: node("a", from),
    over: { ...node("b", to), rect: {}, disabled: false },
    delta,
  }) as unknown as DragEndEvent;

function backend() {
  if (!mockBackend) throw new Error("mock backend expected");
  return mockBackend;
}

const c = () => backend().commands;

const project = (name: string, parentId: string | null = null) => {
  // Taido V2.2 bis: only a group holds projects.
  const parent = backend().state.subjects.find((s) => s.id === parentId);
  if (parent) parent.isGroup = true;
  return c().createSubject({ name, color: null, rootPath: null, parentId });
};

const task = (
  title: string,
  subjectId: string | null,
  sectionId: string | null = null,
) =>
  c().createTask({
    title,
    description: null,
    subjectId,
    sectionId,
    dueDate: null,
    dueTime: null,
  });

const view = (kind: "inbox" | "subject" | "all", subjectId: string | null) =>
  c().getView({ kind, subjectId, from: null, days: null });

const titles = (group: TaskGroup | undefined) =>
  group?.tasks.map((t) => t.title) ?? [];

/** The « À faire » groups, as `[group id, task titles]`. */
async function allGroups() {
  const v = await view("all", null);
  return v.groups.map((g) => [
    g.key.type === "project" ? g.key.name : g.key.type,
    titles(g),
  ]);
}

/** Drag data of a « À faire » row, as `SortableTaskRow` builds it. */
async function allRow(taskId: string): Promise<TaskDrag> {
  const v = await view("all", null);
  for (const g of v.groups) {
    const index = g.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) continue;
    const row = g.tasks[index];
    return {
      type: "task",
      taskId,
      title: row.title,
      place: { subjectId: row.subjectId, sectionId: row.sectionId },
      groupId: g.key.type === "project" ? `project:${g.key.id}` : "no_project",
      index,
      reorderable: true,
      groupRows: g.tasks,
    };
  }
  throw new Error(`no row ${taskId}`);
}

/** Drag data of a « À faire » group, as `projectGroupDrag` builds it. */
async function allGroup(subjectId: string | null): Promise<GroupDrag> {
  const v = await view("all", null);
  const g = v.groups.find((x) =>
    subjectId === null
      ? x.key.type === "no_project"
      : x.key.type === "project" && x.key.id === subjectId,
  );
  if (!g?.order) throw new Error(`no group ${subjectId}`);
  return {
    type: "project_group",
    subjectId,
    name: g.key.type === "project" ? g.key.name : "Sans projet",
    index: g.order.index,
    parentId: g.order.parentId,
    groupId: subjectId === null ? "no_project" : `project:${subjectId}`,
    place: { subjectId, sectionId: null },
  };
}

const sidebarInbox = (index: number): DragData => ({
  type: "subject",
  subjectId: null,
  name: "Sans projet",
  index,
  parentId: null,
});

const order = async () => {
  const subjects = (await c().listSubjects()).filter(
    (s) => s.parentId === null,
  );
  const names = subjects.map((s) => s.name);
  names.splice(await c().getInboxIndex(), 0, "*");
  return names;
};

describe("dropIndex", () => {
  const p = (id: string, place: Place): PlacedRow => ({ id, ...place });
  const s0 = { subjectId: "p", sectionId: null };
  const s1 = { subjectId: "p", sectionId: "s1" };

  it("is the target's index in a group of one place", () => {
    const rows = ["a", "b", "c", "d"].map((id) => p(id, s0));
    expect(dropIndex(rows, "d", "b")).toBe(1);
    expect(dropIndex(rows, "a", "c")).toBe(2);
    expect(dropIndex(rows, "b", "a")).toBe(0);
    // From another group: it takes the target's slot.
    expect(dropIndex(rows, "x", "c")).toBe(2);
    expect(dropIndex(rows, "x", "a")).toBe(0);
  });

  it("counts only the target's place in a mixed « À faire » group", () => {
    const rows = [p("a", s0), p("b", s0), p("c", s1), p("d", s1)];
    // Up, from another section: d before b → [a, d, b] in s0.
    expect(dropIndex(rows, "d", "b")).toBe(1);
    // Down, across places: a after c → [c, a, d] in s1.
    expect(dropIndex(rows, "a", "c")).toBe(1);
    // Down one step within its own place: a after b.
    expect(dropIndex(rows, "a", "b")).toBe(1);
    // Up onto the first row of the next place: d before c → [d, c] in s1.
    expect(dropIndex(rows, "d", "c")).toBe(0);
    // From another group: before the target, within the target's place.
    expect(dropIndex(rows, "x", "d")).toBe(1);
    expect(dropIndex(rows, "x", "c")).toBe(0);
  });

  it("is 0 when the target is unknown", () => {
    expect(dropIndex([], "a", "b")).toBe(0);
  });
});

describe("handleDragEnd", () => {
  beforeEach(() => backend().reset({ seed: false }));

  it("moves a task dropped on a sidebar subject, and reorders tasks", async () => {
    const subject = await project("Globex");
    const a = await task("A", null);
    const b = await task("B", null);
    const inbox = { subjectId: null, sectionId: null };
    const rows: PlacedRow[] = [
      { id: a.id, ...inbox },
      { id: b.id, ...inbox },
    ];
    const taskData = (id: string, title: string, index: number): TaskDrag => ({
      type: "task",
      taskId: id,
      title,
      place: inbox,
      groupId: "inbox",
      index,
      reorderable: true,
      groupRows: rows,
    });

    await handleDragEnd(event(taskData(b.id, "B", 1), taskData(a.id, "A", 0)));
    let v = await view("inbox", null);
    expect(titles(v.groups[0])).toEqual(["B", "A"]);

    await handleDragEnd(
      event(taskData(a.id, "A", 1), {
        type: "subject",
        subjectId: subject.id,
        name: "Globex",
        index: 0,
        parentId: null,
      }),
    );
    v = await view("subject", subject.id);
    expect(titles(v.groups[0])).toEqual(["A"]);

    // Dropped on the sidebar « Sans projet » row: back without project.
    await handleDragEnd(
      event(
        {
          ...taskData(a.id, "A", 0),
          place: { subjectId: subject.id, sectionId: null },
        },
        sidebarInbox(1),
      ),
    );
    v = await view("inbox", null);
    expect(titles(v.groups[0])).toEqual(["B", "A"]);
  });

  it("reorders projects within their level only (groups, Taido V2.2 bis)", async () => {
    const globex = await project("Globex");
    const a = await project("A", globex.id);
    const b = await project("B", globex.id);
    const perso = await project("Perso");
    const data = (
      s: { id: string; name: string },
      index: number,
      parentId: string | null,
    ): DragData => ({
      type: "subject",
      subjectId: s.id,
      name: s.name,
      index,
      parentId,
    });
    const names = async () => (await c().listSubjects()).map((s) => s.name);

    await handleDragEnd(event(data(b, 1, globex.id), data(a, 0, globex.id)));
    expect(await names()).toEqual(["Globex", "B", "A", "Perso"]);
    // Dropped on another level: nothing moves (« Ajouter à un groupe » does that).
    await handleDragEnd(event(data(a, 1, globex.id), data(perso, 1, null)));
    expect(await names()).toEqual(["Globex", "B", "A", "Perso"]);
    expect(
      (await c().listSubjects()).find((s) => s.id === a.id)?.parentId,
    ).toBe(globex.id);
    await handleDragEnd(event(data(perso, 1, null), data(globex, 0, null)));
    expect(await names()).toEqual(["Perso", "Globex", "B", "A"]);
  });

  it("moves « Sans projet » among the top-level projects from the sidebar", async () => {
    const globex = await project("Globex");
    const perso = await project("Perso");
    const top = (s: { id: string; name: string }, index: number): DragData => ({
      type: "subject",
      subjectId: s.id,
      name: s.name,
      index,
      parentId: null,
    });
    expect(await order()).toEqual(["Globex", "Perso", "*"]);
    await handleDragEnd(event(sidebarInbox(2), top(globex, 0)));
    expect(await order()).toEqual(["*", "Globex", "Perso"]);
    // A project's index counts « Sans projet »: Perso dropped on it takes its slot.
    await handleDragEnd(event(top(perso, 2), sidebarInbox(0)));
    expect(await order()).toEqual(["Perso", "*", "Globex"]);
    await handleDragEnd(event(top(perso, 0), top(globex, 2)));
    expect(await order()).toEqual(["*", "Globex", "Perso"]);
    // « Sans projet » never lands among a group's projects.
    const client = await project("Client", globex.id);
    await handleDragEnd(
      event(sidebarInbox(0), {
        type: "subject",
        subjectId: client.id,
        name: "Client",
        index: 0,
        parentId: globex.id,
      }),
    );
    expect(await order()).toEqual(["*", "Globex", "Perso"]);
  });

  it("reorders « À faire » groups by their header, within their level", async () => {
    // Taido V2.2 bis: Globex is a group (no tasks, so no header of its own).
    const globex = await project("Globex");
    const client = await project("Client", globex.id);
    const agence = await project("Agence", globex.id);
    const perso = await project("Perso");
    await task("Maquette", client.id);
    await task("Logo", agence.id);
    await task("Passeport", perso.id);
    await task("Raycast", null);
    const groupNames = async () => (await allGroups()).map(([name]) => name);
    expect(await groupNames()).toEqual([
      "Client",
      "Agence",
      "Perso",
      "no_project",
    ]);

    // « Sans projet » on Perso: before it.
    await handleDragEnd(event(await allGroup(null), await allGroup(perso.id)));
    expect(await groupNames()).toEqual([
      "Client",
      "Agence",
      "no_project",
      "Perso",
    ]);
    // A project among its group's projects.
    await handleDragEnd(
      event(await allGroup(agence.id), await allGroup(client.id)),
    );
    expect(await groupNames()).toEqual([
      "Agence",
      "Client",
      "no_project",
      "Perso",
    ]);
    // Refused: another level, and the group on itself.
    await handleDragEnd(
      event(await allGroup(client.id), await allGroup(perso.id)),
    );
    await handleDragEnd(
      event(await allGroup(perso.id), {
        ...(await allGroup(perso.id)),
        index: 3,
      }),
    );
    await handleDragEnd(event(await allGroup(null), await allGroup(agence.id)));
    expect(await groupNames()).toEqual([
      "Agence",
      "Client",
      "no_project",
      "Perso",
    ]);
  });

  it("reorders and moves tasks in « À faire », each row with its own place", async () => {
    const globex = await project("Globex");
    const perso = await project("Perso");
    const section = await c().createSection({
      subjectId: globex.id,
      name: "Devis",
      subpath: null,
    });
    const a = await task("A", globex.id);
    const b = await task("B", globex.id);
    const c1 = await task("C", globex.id, section.id);
    const d = await task("D", globex.id, section.id);
    const p = await task("P", perso.id);
    const loose = await task("L", null);
    expect(await allGroups()).toEqual([
      ["Globex", ["A", "B", "C", "D"]],
      ["Perso", ["P"]],
      ["no_project", ["L"]],
    ]);

    // D on B: into the tasks outside sections, before B.
    await handleDragEnd(event(await allRow(d.id), await allRow(b.id)));
    expect(await allGroups()).toEqual([
      ["Globex", ["A", "D", "B", "C"]],
      ["Perso", ["P"]],
      ["no_project", ["L"]],
    ]);
    let moved = backend().state.tasks.find((t) => t.id === d.id);
    expect(moved?.sectionId).toBeNull();

    // A on C: into « Devis », after C (the list showed it there).
    await handleDragEnd(event(await allRow(a.id), await allRow(c1.id)));
    expect(await allGroups()).toEqual([
      ["Globex", ["D", "B", "C", "A"]],
      ["Perso", ["P"]],
      ["no_project", ["L"]],
    ]);
    moved = backend().state.tasks.find((t) => t.id === a.id);
    expect(moved?.sectionId).toBe(section.id);

    // L on P: another group, before P.
    await handleDragEnd(event(await allRow(loose.id), await allRow(p.id)));
    expect(await allGroups()).toEqual([
      ["Globex", ["D", "B", "C", "A"]],
      ["Perso", ["L", "P"]],
    ]);

    // P on the Globex group area: appended to Globex, outside sections.
    await handleDragEnd(event(await allRow(p.id), await allGroup(globex.id)));
    expect(await allGroups()).toEqual([
      ["Globex", ["D", "B", "P", "C", "A"]],
      ["Perso", ["L"]],
    ]);
    moved = backend().state.tasks.find((t) => t.id === p.id);
    expect(moved).toMatchObject({ subjectId: globex.id, sectionId: null });

    // C on its own group's area: nothing moves.
    await handleDragEnd(event(await allRow(c1.id), await allGroup(globex.id)));
    expect(await allGroups()).toEqual([
      ["Globex", ["D", "B", "P", "C", "A"]],
      ["Perso", ["L"]],
    ]);

    // L on the « Sans projet » group: appended there, without project.
    await task("M", null);
    await handleDragEnd(event(await allRow(loose.id), await allGroup(null)));
    expect(await allGroups()).toEqual([
      ["Globex", ["D", "B", "P", "C", "A"]],
      ["no_project", ["M", "L"]],
    ]);
  });

  it("leaves Today's rows where they are", async () => {
    const a = await task("A", null);
    const b = await task("B", null);
    const today: TaskDrag = {
      type: "task",
      taskId: a.id,
      title: "A",
      place: { subjectId: null, sectionId: null },
      groupId: "today_rest",
      index: 0,
      reorderable: false,
      groupRows: [],
    };
    await handleDragEnd(
      event(today, { ...today, taskId: b.id, title: "B", index: 1 }),
    );
    const v = await view("inbox", null);
    expect(titles(v.groups[0])).toEqual(["A", "B"]);
  });
});

describe("calendar of « Prochainement »", () => {
  it("moves a task to the day it is dropped on, keeping its time", async () => {
    const t = await c().createTask({
      title: "Appeler qonto",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: "2030-10-14",
      dueTime: "09:30",
    });
    const from: DragData = {
      type: "calendar_task",
      taskId: t.id,
      title: "Appeler qonto",
      date: "2030-10-14",
      time: "09:30",
    };
    const day = (date: string): DragData => ({
      type: "calendar_day",
      date,
      label: date,
    });
    // Dropped back on its own day: nothing changes.
    await handleDragEnd(event(from, day("2030-10-14")));
    expect((await c().getTask(t.id)).due).toMatchObject({
      date: "2030-10-14",
      time: "09:30",
    });
    await handleDragEnd(event(from, day("2030-10-16")));
    expect((await c().getTask(t.id)).due).toMatchObject({
      date: "2030-10-16",
      time: "09:30",
    });
    // A calendar task dropped anywhere else does nothing.
    await handleDragEnd(
      event(from, {
        type: "subject",
        subjectId: null,
        name: "Sans projet",
        index: 0,
        parentId: null,
      }),
    );
    expect((await c().getTask(t.id)).due?.date).toBe("2030-10-16");
  });
});

describe("« Prochainement » list", () => {
  it("moves a row to the day it is dropped on, keeping its time", async () => {
    const t = await c().createTask({
      title: "Appeler qonto",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: "2030-10-14",
      dueTime: "11:00",
    });
    const from: TaskDrag = {
      type: "task",
      taskId: t.id,
      title: "Appeler qonto",
      place: { subjectId: null, sectionId: null },
      groupId: "day:2030-10-14",
      index: 0,
      reorderable: false,
      groupRows: [],
      day: { date: "2030-10-14", time: "11:00" },
    };
    const day = (date: string): DragData => ({
      type: "group",
      groupId: `day:${date}`,
      place: { subjectId: null, sectionId: null },
      reorderable: false,
      date,
    });
    await handleDragEnd(event(from, day("2030-10-14")));
    expect((await c().getTask(t.id)).due?.date).toBe("2030-10-14");
    await handleDragEnd(event(from, day("2030-10-15")));
    expect((await c().getTask(t.id)).due).toMatchObject({
      date: "2030-10-15",
      time: "11:00",
    });
    // A group without date (« En retard ») changes nothing.
    await handleDragEnd(
      event(
        { ...from, day: { date: "2030-10-15", time: "11:00" } },
        {
          type: "group",
          groupId: "today_overdue",
          place: { subjectId: null, sectionId: null },
          reorderable: false,
        },
      ),
    );
    expect((await c().getTask(t.id)).due?.date).toBe("2030-10-15");
  });
});

describe("notebook pages (task 6)", () => {
  type PageDrag = Extract<DragData, { type: "note_page" }>;

  async function notebook() {
    const subject = await project("Taido");
    const decisions = await c().createNoteGroup({
      subjectId: subject.id,
      name: "Décisions",
    });
    const archives = await c().createNoteGroup({
      subjectId: subject.id,
      name: "Archives",
    });
    const page = (title: string, groupId: string | null, summary = false) =>
      c().createNotePage({
        subjectId: subject.id,
        groupId,
        title,
        body: "",
        kind: summary ? "summary" : "page",
        sourceTaskId: null,
      });
    const a = await page("A", decisions.id);
    const b = await page("B", decisions.id);
    const cc = await page("C", decisions.id);
    const loose = await page("Vrac", null);
    const sum = await page("Résumé", null, true);
    return { subjectId: subject.id, decisions, archives, a, b, cc, loose, sum };
  }

  /** Drag data of a page as the list builds it (its block's pages in display order). */
  async function pageDrag(subjectId: string, id: string): Promise<PageDrag> {
    const nb = await c().notebook(subjectId);
    const blocks: [
      NoteTarget,
      { id: string; title: string; kind: string }[],
    ][] = [
      ["pinned", nb.pinned],
      ["ungrouped", nb.ungrouped],
      ...nb.groups.map((g): [NoteTarget, typeof g.pages] => [
        { group: { id: g.group.id } },
        g.pages,
      ]),
      ["summaries", nb.summaries],
    ];
    for (const [place, pages] of blocks) {
      const row = pages.find((p) => p.id === id);
      if (!row) continue;
      return {
        type: "note_page",
        pageId: id,
        title: row.title,
        kind: row.kind as PageDrag["kind"],
        subjectId,
        place,
        blockPages: pages.map((p) => p.id),
      };
    }
    throw new Error(`no page ${id}`);
  }

  const zone = (subjectId: string, place: NoteTarget): DragData => ({
    type: "note_group_drop",
    subjectId,
    place,
    name: "zone",
  });

  const groupTitles = async (subjectId: string, groupId: string) =>
    (await c().notebook(subjectId)).groups
      .find((g) => g.group.id === groupId)
      ?.pages.map((p) => p.title);

  it("a page dropped on another page of its group takes its slot", async () => {
    const nb = await notebook();
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.cc.id),
        await pageDrag(nb.subjectId, nb.a.id),
      ),
    );
    expect(await groupTitles(nb.subjectId, nb.decisions.id)).toEqual([
      "C",
      "A",
      "B",
    ]);
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.cc.id),
        await pageDrag(nb.subjectId, nb.b.id),
      ),
    );
    expect(await groupTitles(nb.subjectId, nb.decisions.id)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("a page dropped on a page of group X moves into X at that slot", async () => {
    const nb = await notebook();
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.loose.id),
        await pageDrag(nb.subjectId, nb.b.id),
      ),
    );
    expect(await groupTitles(nb.subjectId, nb.decisions.id)).toEqual([
      "A",
      "Vrac",
      "B",
      "C",
    ]);
  });

  it("a page dropped on « Épinglées » is pinned", async () => {
    const nb = await notebook();
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.b.id),
        zone(nb.subjectId, "pinned"),
      ),
    );
    const view = await c().notebook(nb.subjectId);
    expect(view.pinned.map((p) => p.title)).toEqual(["B"]);
  });

  it("a page dropped on a pinned page is pinned too", async () => {
    const nb = await notebook();
    await c().pinNotePage({ id: nb.a.id, pinned: true });
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.loose.id),
        await pageDrag(nb.subjectId, nb.a.id),
      ),
    );
    const view = await c().notebook(nb.subjectId);
    expect(view.pinned.map((p) => p.title)).toEqual(["A", "Vrac"]);
  });

  it("a pinned page dropped in group Y leaves « Épinglées » for Y", async () => {
    const nb = await notebook();
    await c().pinNotePage({ id: nb.a.id, pinned: true });
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.a.id),
        zone(nb.subjectId, { group: { id: nb.archives.id } }),
      ),
    );
    const view = await c().notebook(nb.subjectId);
    expect(view.pinned).toEqual([]);
    expect(await groupTitles(nb.subjectId, nb.archives.id)).toEqual(["A"]);
  });

  it("a page dropped on another group's area goes to its end", async () => {
    const nb = await notebook();
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.loose.id),
        zone(nb.subjectId, { group: { id: nb.decisions.id } }),
      ),
    );
    expect(await groupTitles(nb.subjectId, nb.decisions.id)).toEqual([
      "A",
      "B",
      "C",
      "Vrac",
    ]);
    // Its own group's area: nothing moves.
    const spy = vi.spyOn(commands, "moveNotePage");
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.a.id),
        zone(nb.subjectId, { group: { id: nb.decisions.id } }),
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a plain page is refused by « Résumés de tâches »: no zone lit, no command", async () => {
    const nb = await notebook();
    const from = await pageDrag(nb.subjectId, nb.a.id);
    expect(notePageAccepts(from, "summaries")).toBe(false);
    const spy = vi.spyOn(commands, "moveNotePage");
    await handleDragEnd(event(from, zone(nb.subjectId, "summaries")));
    await handleDragEnd(event(from, await pageDrag(nb.subjectId, nb.sum.id)));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await c().notebook(nb.subjectId)).summaries).toHaveLength(1);
  });

  it("a page held still then released is not dropped where the finger rests", async () => {
    const nb = await notebook();
    const spy = vi.spyOn(commands, "moveNotePage");
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.loose.id),
        zone(nb.subjectId, "pinned"),
        { x: 3, y: -4 },
      ),
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await c().notebook(nb.subjectId)).pinned).toEqual([]);
  });

  it("what each zone accepts", async () => {
    const nb = await notebook();
    const plain = await pageDrag(nb.subjectId, nb.a.id);
    const summary = await pageDrag(nb.subjectId, nb.sum.id);
    const group = { group: { id: nb.archives.id } };
    expect(notePageAccepts(plain, "pinned")).toBe(true);
    expect(notePageAccepts(plain, "ungrouped")).toBe(true);
    expect(notePageAccepts(plain, group)).toBe(true);
    // A summary outside any group is in « Résumés de tâches », never with plain pages.
    expect(notePageAccepts(summary, "summaries")).toBe(true);
    expect(notePageAccepts(summary, "ungrouped")).toBe(false);
    expect(notePageAccepts(summary, group)).toBe(true);
    // No reordering in « Épinglées ».
    await c().pinNotePage({ id: nb.b.id, pinned: true });
    const pinned = await pageDrag(nb.subjectId, nb.b.id);
    expect(notePageAccepts(pinned, "pinned")).toBe(false);
    // Another project's notebook never receives it.
    expect(notePageAccepts(plain, "ungrouped", "another-project")).toBe(false);
  });

  it("a summary moved out of a group goes back to « Résumés de tâches »", async () => {
    const nb = await notebook();
    await c().moveNotePage({
      id: nb.sum.id,
      target: { group: { id: nb.archives.id } },
      index: null,
    });
    await handleDragEnd(
      event(
        await pageDrag(nb.subjectId, nb.sum.id),
        zone(nb.subjectId, "summaries"),
      ),
    );
    const view = await c().notebook(nb.subjectId);
    expect(view.summaries.map((p) => p.title)).toEqual(["Résumé"]);
  });

  it("a task never lands on a page, nor a page on a sidebar project", async () => {
    const nb = await notebook();
    const spy = vi.spyOn(commands, "moveNotePage");
    const moveTask = vi.spyOn(commands, "moveTask");
    await handleDragEnd(
      event(await pageDrag(nb.subjectId, nb.a.id), sidebarInbox(0)),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    spy.mockRestore();
    moveTask.mockRestore();
  });
});
