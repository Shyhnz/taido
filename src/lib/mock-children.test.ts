/**
 * Contract in the mock: subtasks are child tasks, priority 1 to 4, and the
 * « Prochainement » view (one group per day, overdue first).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GetViewInput,
  TaskRow,
  TaskStateChanged,
  ViewModel,
} from "../bindings";
import { MockBackend } from "./mock-backend";
import { AGENT_DELAYS } from "./mock-sessions";

// Saturday 3 October 2026, 10:00 local time.
const NOW = new Date(2026, 9, 3, 10, 0);

let backend: MockBackend;
let c: MockBackend["commands"];

const task = (
  title: string,
  extra: Partial<Parameters<MockBackend["commands"]["createTask"]>[0]> = {},
) =>
  c.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
    ...extra,
  });

const view = (input: Partial<GetViewInput> & Pick<GetViewInput, "kind">) =>
  c.getView({ subjectId: null, from: null, days: null, ...input });

const titles = (rows: TaskRow[]) => rows.map((r) => r.title);

const groupOf = (v: ViewModel, type: string, date?: string) =>
  v.groups.find(
    (g) =>
      g.key.type === type &&
      (date === undefined || (g.key.type === "day" && g.key.date === date)),
  );

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  backend = new MockBackend({ now: () => new Date(), seed: false });
  c = backend.commands;
});

afterEach(() => {
  backend.reset();
  vi.useRealTimers();
});

describe("subtasks are child tasks", () => {
  it("shows children under their task, open ones first, with the counter", async () => {
    const parent = await task("Parent");
    const a = await c.addSubtask({ taskId: parent.id, text: "Un" });
    const b = await c.addSubtask({ taskId: parent.id, text: "Deux" });
    await c.toggleSubtask(a.id);

    const inbox = await view({ kind: "inbox" });
    // Children are not rows of their own in a project list.
    expect(titles(inbox.groups[0].tasks)).toEqual(["Parent"]);
    expect(inbox.openCount).toBe(1);
    const row = inbox.groups[0].tasks[0];
    expect(row).toMatchObject({ subtasksDone: 1, subtasksTotal: 2 });
    expect(titles(row.children)).toEqual(["Deux", "Un"]);
    expect(row.children[0]).toMatchObject({
      id: b.id,
      parentId: parent.id,
      children: [],
      priority: 1,
    });
    expect(row.children[1].completedAt).not.toBeNull();
    expect((await c.getCounts()).inbox).toBe(1);

    // A child has its own panel, with the way back to its parent.
    const child = await c.getTask(b.id);
    expect(child.parent).toEqual({ id: parent.id, title: "Parent" });
    expect((await c.getTask(parent.id)).subtasks.map((s) => s.id)).toEqual([
      b.id,
      a.id,
    ]);
  });

  it("lists completed children most recent first, like the core", async () => {
    const parent = await task("Parent");
    const ids: string[] = [];
    for (const text of ["Un", "Deux", "Trois"]) {
      ids.push((await c.addSubtask({ taskId: parent.id, text })).id);
    }
    await c.toggleSubtask(ids[0]);
    vi.advanceTimersByTime(60_000);
    await c.toggleSubtask(ids[2]);
    const row = (await view({ kind: "inbox" })).groups[0].tasks[0];
    expect(titles(row.children)).toEqual(["Deux", "Trois", "Un"]);
    expect((await c.getTask(parent.id)).subtasks.map((s) => s.text)).toEqual([
      "Deux",
      "Trois",
      "Un",
    ]);
  });

  it("completes open children with their parent; one reopened is listed on its own", async () => {
    const parent = await task("Parent");
    const a = await c.addSubtask({ taskId: parent.id, text: "Un" });
    const b = await c.addSubtask({ taskId: parent.id, text: "Deux" });
    await c.setTaskCompleted({ id: parent.id, completed: true });
    const detail = await c.getTask(parent.id);
    expect(detail.subtasks.every((s) => s.done)).toBe(true);
    expect((await c.listJournal(a.id)).map((e) => e.kind)).toContain(
      "completed",
    );
    let inbox = await view({ kind: "inbox" });
    expect(inbox.groups[0].tasks).toEqual([]);
    expect(titles(inbox.completed[0].children)).toEqual(["Un", "Deux"]);

    // Reopening the parent leaves them done.
    await c.setTaskCompleted({ id: parent.id, completed: false });
    expect((await c.getTask(parent.id)).subtasks.every((s) => s.done)).toBe(
      true,
    );
    await c.setTaskCompleted({ id: parent.id, completed: true });
    // A subtask reopened under a completed task shows in the open list, not twice.
    await c.toggleSubtask(b.id);
    inbox = await view({ kind: "inbox" });
    expect(titles(inbox.groups[0].tasks)).toEqual(["Deux"]);
    expect(inbox.groups[0].tasks[0].parentId).toBe(parent.id);
    expect(titles(inbox.completed[0].children)).toEqual(["Un"]);
    expect((await c.getCounts()).inbox).toBe(1);
  });

  it("notifies a task's children when it changes, like the core", async () => {
    const subject = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const parent = await task("Parent");
    const a = await c.addSubtask({ taskId: parent.id, text: "Un" });
    const b = await c.addSubtask({ taskId: parent.id, text: "Deux" });
    const ids: (string[] | null)[] = [];
    await backend.events.dataChanged.listen((e) => ids.push(e.payload.taskIds));
    // Their panels show its title, project and folder.
    await c.updateTask({ id: parent.id, title: "P", description: null });
    await c.moveTask({
      id: parent.id,
      subjectId: subject.id,
      sectionId: null,
      index: null,
    });
    await c.setTaskWorkdirOverride({ id: parent.id, path: "/tmp/p" });
    expect(ids).toEqual([
      [parent.id, a.id, b.id],
      [parent.id, a.id, b.id],
      [parent.id, a.id, b.id],
    ]);
  });

  it("refuses a subtask of a subtask (one level)", async () => {
    const parent = await task("Parent");
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    await expect(
      c.addSubtask({ taskId: child.id, text: "Petit-enfant" }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("keeps children in their parent's place and folder", async () => {
    const subject = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const parent = await task("Parent");
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    await c.moveTask({
      id: parent.id,
      subjectId: subject.id,
      sectionId: null,
      index: null,
    });
    const moved = await c.getTask(child.id);
    expect(moved.subject?.id).toBe(subject.id);
    expect(moved.workdir?.path).toBe("/tmp/globex");
    const project = await view({ kind: "subject", subjectId: subject.id });
    expect(titles(project.groups[0].tasks)).toEqual(["Parent"]);
  });

  it("refuses to move a subtask on its own, like the core", async () => {
    const parent = await task("Parent");
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    await expect(
      c.moveTask({ id: child.id, subjectId: null, sectionId: null, index: 0 }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("deletes and restores a task with its children", async () => {
    const parent = await task("Parent");
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    await c.deleteTask(parent.id);
    await expect(c.getTask(child.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await c.restoreTask(parent.id);
    expect((await c.getTask(child.id)).title).toBe("Enfant");
  });

  it("shows a due subtask alone in Today unless its parent is there, like the core", async () => {
    const parent = await task("Parent");
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    await c.setTaskDue({ id: child.id, date: "2026-10-03", time: null });
    let today = await view({ kind: "today" });
    expect(titles(today.groups[0].tasks)).toEqual(["Enfant"]);
    expect(today.groups[0].tasks[0].parentId).toBe(parent.id);
    expect(today.openCount).toBe(1);
    await c.setTaskDue({ id: parent.id, date: "2026-10-03", time: null });
    today = await view({ kind: "today" });
    expect(titles(today.groups[0].tasks)).toEqual(["Parent"]);
    expect(titles(today.groups[0].tasks[0].children)).toEqual(["Enfant"]);
  });

  it("gives the parent the most critical ring of its children", async () => {
    const changes: TaskStateChanged[] = [];
    await backend.events.taskStateChanged.listen((e) =>
      changes.push(e.payload),
    );
    const subject = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const parent = await task("Parent", { subjectId: subject.id });
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    const term = await c.openTerminal({
      taskId: child.id,
      kind: "agent",
      agent: null,
      command: null,
      initialPrompt: null,
      permissionMode: null,
      addTaskContext: null,
      cols: 80,
      rows: 24,
    });
    await vi.advanceTimersByTimeAsync(AGENT_DELAYS.start);
    await c.writeTerminal({ terminalId: term.id, data: "/p\r" });

    expect((await c.getTask(parent.id)).ring).toBe("waiting");
    // The subtask line of the panel keeps the child's own ring.
    expect((await c.getTask(parent.id)).subtasks[0]).toMatchObject({
      id: child.id,
      ring: "waiting",
      openTerminals: 1,
    });
    // Both rows get the instant update.
    expect(
      changes.filter((x) => x.ring === "waiting").map((x) => x.taskId),
    ).toEqual(expect.arrayContaining([child.id, parent.id]));
    // Today lists the waiting child on its own, in « Claude attend », not its parent.
    const today = await view({ kind: "today" });
    expect(today.groups[0].key).toEqual({ type: "today_waiting" });
    expect(titles(today.groups[0].tasks)).toEqual(["Enfant"]);
    expect((await c.getCounts()).waiting).toBe(1);
    expect((await c.listSubjects())[0].dot).toBe("waiting");
  });
});

describe("priority", () => {
  it("sets 1 to 4 and refuses anything else", async () => {
    const t = await task("Urgent");
    expect(t.priority).toBe(1);
    expect((await c.setTaskPriority({ id: t.id, priority: 4 })).priority).toBe(
      4,
    );
    const inbox = await view({ kind: "inbox" });
    expect(inbox.groups[0].tasks[0].priority).toBe(4);
    for (const priority of [0, 5, 2.5]) {
      await expect(
        c.setTaskPriority({ id: t.id, priority }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }
  });
});

describe("« Prochainement »", () => {
  it("lists seven days from today, overdue first, each with its add row", async () => {
    await task("En retard", { dueDate: "2026-10-01" });
    await task("Aujourd'hui", { dueDate: "2026-10-03" });
    await task("Lundi", { dueDate: "2026-10-05", dueTime: "09:00" });
    await task("Plus tard", { dueDate: "2026-10-20" });
    await task("Sans date");

    const v = await view({ kind: "upcoming" });
    expect(v.kind).toBe("upcoming");
    expect(v.groups.map((g) => g.key)).toEqual([
      { type: "today_overdue" },
      ...[
        "2026-10-03",
        "2026-10-04",
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
        "2026-10-08",
        "2026-10-09",
      ].map((date) => ({ type: "day", date })),
    ]);
    expect(titles(v.groups[0].tasks)).toEqual(["En retard"]);
    expect(v.groups[0].addTarget).toBeNull();
    expect(titles(groupOf(v, "day", "2026-10-03")?.tasks ?? [])).toEqual([
      "Aujourd'hui",
    ]);
    expect(titles(groupOf(v, "day", "2026-10-05")?.tasks ?? [])).toEqual([
      "Lundi",
    ]);
    // Empty days stay, with their add row; today's adds tasks due today.
    expect(groupOf(v, "day", "2026-10-04")).toMatchObject({
      tasks: [],
      showHeader: true,
      addTarget: { subjectId: null, sectionId: null, dueToday: false },
    });
    expect(groupOf(v, "day", "2026-10-03")?.addTarget?.dueToday).toBe(true);
    expect(v.openCount).toBe(3);
    expect(v.completed).toEqual([]);
  });

  it("starts at `from`: past days are empty, later weeks have no overdue", async () => {
    await task("En retard", { dueDate: "2026-10-01" });
    await task("Plus tard", { dueDate: "2026-10-14" });

    const week = await view({ kind: "upcoming", from: "2026-09-28" });
    expect(week.groups[0].key).toEqual({ type: "today_overdue" });
    const monday = groupOf(week, "day", "2026-09-28");
    // Like the core: an empty past day, still with its dated add row (the UI hides it).
    expect(monday).toMatchObject({
      tasks: [],
      addTarget: { dueDate: "2026-09-28", dueToday: false },
    });

    const next = await view({ kind: "upcoming", from: "2026-10-12", days: 3 });
    expect(next.groups.map((g) => g.key)).toEqual([
      { type: "day", date: "2026-10-12" },
      { type: "day", date: "2026-10-13" },
      { type: "day", date: "2026-10-14" },
    ]);
    expect(titles(next.groups[2].tasks)).toEqual(["Plus tard"]);
    // A dated subtask shows on its own day; under its parent when it is due the same day.
    const parent = next.groups[2].tasks[0];
    const alone = await c.addSubtask({ taskId: parent.id, text: "Seule" });
    await c.setTaskDue({ id: alone.id, date: "2026-10-13", time: null });
    const nested = await c.addSubtask({ taskId: parent.id, text: "Dessous" });
    await c.setTaskDue({ id: nested.id, date: "2026-10-14", time: null });
    const late = await c.addSubtask({ taskId: parent.id, text: "Oubliée" });
    await c.setTaskDue({ id: late.id, date: "2026-10-02", time: null });
    const withSubs = await view({
      kind: "upcoming",
      from: "2026-10-12",
      days: 3,
    });
    expect(titles(withSubs.groups[1].tasks)).toEqual(["Seule"]);
    expect(titles(withSubs.groups[2].tasks)).toEqual(["Plus tard"]);
    expect(titles(withSubs.groups[2].tasks[0].children)).toEqual([
      "Seule",
      "Dessous",
      "Oubliée",
    ]);
    const thisWeek = await view({ kind: "upcoming" });
    expect(titles(thisWeek.groups[0].tasks)).toEqual(["En retard", "Oubliée"]);
    // « Reporter à aujourd'hui » moves late subtasks too.
    expect(await c.rescheduleOverdue()).toBe(2);
    expect((await c.getTask(late.id)).due?.date).toBe("2026-10-03");
    await expect(
      view({ kind: "upcoming", from: "demain" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    // `days` is clamped to 1–62 like the core, not refused.
    const one = await view({ kind: "upcoming", from: "2026-10-12", days: 0 });
    expect(one.groups.map((g) => g.key)).toEqual([
      { type: "day", date: "2026-10-12" },
    ]);
  });
});
