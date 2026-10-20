import { beforeEach, describe, expect, it } from "vitest";
import type { CountsChanged, DataChanged, TaskRow } from "../bindings";
import {
  MOCK_CLAUDE_PATH,
  MOCK_PICKED_FOLDER,
  MockBackend,
} from "./mock-backend";

// Thursday 1 October 2026, 10:00 local time.
let clock = new Date(2026, 9, 1, 10, 0);
const now = () => clock;

const titles = (rows: TaskRow[]) => rows.map((r) => r.title);

const input = {
  task: (
    title: string,
    extra: Partial<Parameters<MockBackend["commands"]["createTask"]>[0]> = {},
  ) => ({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
    ...extra,
  }),
};

describe("MockBackend", () => {
  let backend: MockBackend;
  let c: MockBackend["commands"];

  beforeEach(() => {
    clock = new Date(2026, 9, 1, 10, 0);
    backend = new MockBackend({ now, seed: false });
    c = backend.commands;
  });

  async function subjectWithSections() {
    const subject = await c.createSubject({
      name: "Acme Studio",
      color: "violet",
      rootPath: "/tmp/acme",
      parentId: null,
    });
    const etl = await c.createSection({
      subjectId: subject.id,
      name: "ETL",
      subpath: "etl",
    });
    const reporting = await c.createSection({
      subjectId: subject.id,
      name: "Reporting",
      subpath: null,
    });
    return { subject, etl, reporting };
  }

  it("seeds realistic data by default", async () => {
    const seeded = new MockBackend({ now });
    const subjects = await seeded.commands.listSubjects();
    expect(subjects.map((s) => s.name)).toEqual([
      "Acme Studio",
      // A group, followed by its projects.
      "Clients",
      "Northwind",
      "Bloom Weddings",
      "Globex",
      "Perso",
    ]);
    expect(subjects.filter((s) => s.isGroup).map((s) => s.name)).toEqual([
      "Clients",
    ]);
    const today = await seeded.commands.getView({
      kind: "today",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(today.openCount).toBeGreaterThan(3);
    expect(MOCK_PICKED_FOLDER).toBe(await seeded.commands.pickFolder(null));
  });

  it("validates inputs", async () => {
    await expect(
      c.createSubject({
        name: "  ",
        color: "teal",
        rootPath: "/x",
        parentId: null,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(c.createTask(input.task(""))).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(c.getTask("nope")).rejects.toMatchObject({
      kind: "not_found",
    });
    const { etl } = await subjectWithSections();
    await expect(
      c.createTask(input.task("x", { sectionId: etl.id })),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("filters Today: overdue group, then the rest under its own header", async () => {
    await c.createTask(input.task("Aujourd'hui", { dueDate: "2026-10-01" }));
    await c.createTask(input.task("En retard", { dueDate: "2026-09-28" }));
    await c.createTask(input.task("Très en retard", { dueDate: "2026-09-02" }));
    await c.createTask(input.task("Demain", { dueDate: "2026-10-02" }));
    await c.createTask(input.task("Sans date"));
    const done = await c.createTask(
      input.task("Faite", { dueDate: "2026-10-01" }),
    );
    await c.setTaskCompleted({ id: done.id, completed: true });

    const view = await c.getView({
      kind: "today",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(view.groups.map((g) => [g.key.type, g.showHeader])).toEqual([
      ["today_overdue", true],
      ["today_rest", true],
    ]);
    const [late, rest] = view.groups;
    expect(titles(late.tasks)).toEqual(["Très en retard", "En retard"]);
    expect(late.tasks.every((t) => t.due?.overdue)).toBe(true);
    expect(late.addTarget).toBeNull();
    expect(titles(rest.tasks)).toEqual(["Aujourd'hui"]);
    expect(rest.addTarget).toEqual({
      subjectId: null,
      sectionId: null,
      dueToday: true,
    });
    expect(view.openCount).toBe(3);
    expect(titles(view.completed)).toEqual(["Faite"]);
    expect(view.today).toBe("2026-10-01");
  });

  it("sorts Today by due time, then position", async () => {
    await c.createTask(input.task("Sans heure", { dueDate: "2026-10-01" }));
    await c.createTask(
      input.task("À 17h", { dueDate: "2026-10-01", dueTime: "17:00" }),
    );
    await c.createTask(
      input.task("À 9h", { dueDate: "2026-10-01", dueTime: "09:00" }),
    );
    const view = await c.getView({
      kind: "today",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].showHeader).toBe(false);
    expect(titles(view.groups[0].tasks)).toEqual([
      "À 9h",
      "À 17h",
      "Sans heure",
    ]);
  });

  it("lists loose tasks first, then every section", async () => {
    const { subject, etl, reporting } = await subjectWithSections();
    await c.createTask(
      input.task("A", { subjectId: subject.id, sectionId: etl.id }),
    );
    let view = await c.getView({
      kind: "subject",
      subjectId: subject.id,
      from: null,
      days: null,
    });
    // The loose group is always there, first and without header (it carries the add row).
    expect(view.groups.map((g) => [g.key.type, g.showHeader])).toEqual([
      ["no_section", false],
      ["section", true],
      ["section", true],
    ]);
    expect(view.groups[0].tasks).toEqual([]);
    expect(view.groups[0].addTarget).toEqual({
      subjectId: subject.id,
      sectionId: null,
      dueToday: false,
    });
    expect(view.groups[2].key).toEqual({
      type: "section",
      id: reporting.id,
      name: "Reporting",
      subpath: null,
    });
    expect(view.groups[2].tasks).toEqual([]);
    expect(view.groups[2].addTarget).toEqual({
      subjectId: subject.id,
      sectionId: reporting.id,
      dueToday: false,
    });

    await c.createTask(input.task("B", { subjectId: subject.id }));
    view = await c.getView({
      kind: "subject",
      subjectId: subject.id,
      from: null,
      days: null,
    });
    expect(titles(view.groups[0].tasks)).toEqual(["B"]);
    expect(view.subject?.name).toBe("Acme Studio");
    expect(view.groups[0].tasks[0].subject).toBeNull();

    await c.deleteSection(etl.id);
    view = await c.getView({
      kind: "subject",
      subjectId: subject.id,
      from: null,
      days: null,
    });
    expect(titles(view.groups[0].tasks).sort()).toEqual(["A", "B"]);
  });

  it("puts a deleted section's tasks after the loose ones, in order (core parity)", async () => {
    const { subject, etl } = await subjectWithSections();
    await c.createTask(input.task("loose", { subjectId: subject.id }));
    await c.createTask(
      input.task("t1", { subjectId: subject.id, sectionId: etl.id }),
    );
    await c.createTask(
      input.task("t2", { subjectId: subject.id, sectionId: etl.id }),
    );
    await c.deleteSection(etl.id);
    const view = await c.getView({
      kind: "subject",
      subjectId: subject.id,
      from: null,
      days: null,
    });
    expect(titles(view.groups[0].tasks)).toEqual(["loose", "t1", "t2"]);
  });

  it("moves tasks by index and to another subject", async () => {
    const { subject, etl } = await subjectWithSections();
    const ids: string[] = [];
    for (const t of ["A", "B", "C"]) {
      ids.push((await c.createTask(input.task(t))).id);
    }
    await c.moveTask({
      id: ids[2],
      subjectId: null,
      sectionId: null,
      index: 0,
    });
    let inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(titles(inbox.groups[0].tasks)).toEqual(["C", "A", "B"]);

    await c.setTaskWorkdirOverride({ id: ids[0], path: "/custom" });
    const moved = await c.moveTask({
      id: ids[0],
      subjectId: subject.id,
      sectionId: etl.id,
      index: null,
    });
    expect(moved.workdirOverride).toBeNull();
    expect(moved.workdir).toEqual({
      path: "/tmp/acme/etl",
      source: "section",
      exists: true,
    });
    inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(titles(inbox.groups[0].tasks)).toEqual(["C", "B"]);

    await c.reorderSubject({ id: subject.id, index: 0 });
    const s2 = await c.createSubject({
      name: "Perso",
      color: "gray",
      rootPath: "/p",
      parentId: null,
    });
    await c.reorderSubject({ id: s2.id, index: 0 });
    expect((await c.listSubjects()).map((s) => s.name)).toEqual([
      "Perso",
      "Acme Studio",
    ]);
  });

  it("records completion in the journal and supports undo", async () => {
    const task = await c.createTask(
      input.task("Relancer", { description: "Ligne 1\nLigne 2" }),
    );
    // Rows never show the description, only a note icon.
    const inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(inbox.groups[0].showHeader).toBe(false);
    expect(inbox.groups[0].tasks[0].line).toBeNull();
    expect(inbox.groups[0].tasks[0].hasDescription).toBe(true);
    expect(task.ring).toBe("human");
    expect(task.line).toEqual({
      kind: "description",
      agent: null,
      text: "Ligne 1",
      at: null,
      tone: "muted",
    });

    clock = new Date(2026, 9, 1, 10, 5);
    const done = await c.setTaskCompleted({ id: task.id, completed: true });
    expect(done.ring).toBe("completed");
    expect(done.line?.kind).toBe("completed");
    expect(done.line?.tone).toBe("faint");
    expect(done.ringSince).toBe(done.completedAt);

    clock = new Date(2026, 9, 1, 10, 6);
    await c.setTaskCompleted({ id: task.id, completed: false });
    await c.addNote({ taskId: task.id, text: "Fait le point" });
    const journal = await c.listJournal(task.id);
    expect(journal.map((j) => j.kind)).toEqual([
      "note",
      "reopened",
      "completed",
      "created",
    ]);
  });

  it("maintains counts and emits events", async () => {
    const data: DataChanged[] = [];
    const counts: CountsChanged[] = [];
    await backend.events.dataChanged.listen((e) => data.push(e.payload));
    await backend.events.countsChanged.listen((e) => counts.push(e.payload));

    const { subject } = await subjectWithSections();
    await c.createTask(input.task("Inbox"));
    const t = await c.createTask(
      input.task("Sujet", { subjectId: subject.id, dueDate: "2026-10-01" }),
    );
    expect(counts.at(-1)?.counts).toEqual({
      inbox: 1,
      today: 1,
      waiting: 0,
    });
    expect(data.at(-1)).toEqual({
      scopes: ["tasks", "subjects", "journal"],
      taskIds: [t.id],
    });
    await c.setTaskCompleted({ id: t.id, completed: true });
    expect(counts.at(-1)?.counts.today).toBe(0);
    const subjects = await c.listSubjects();
    expect(subjects[0].openCount).toBe(0);
  });

  it("handles subtasks, duplication and settings", async () => {
    const task = await c.createTask(input.task("Original"));
    const a = await c.addSubtask({ taskId: task.id, text: "Un" });
    await c.addSubtask({ taskId: task.id, text: "Deux" });
    await c.toggleSubtask(a.id);
    await c.reorderSubtask({ id: a.id, index: 1 });
    let detail = await c.getTask(task.id);
    expect(detail.subtasks.map((s) => [s.text, s.done])).toEqual([
      ["Deux", false],
      ["Un", true],
    ]);

    const copy = await c.duplicateTask(task.id);
    expect(copy.subtasks).toHaveLength(2);
    const inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(inbox.groups[0].tasks.map((t) => t.id)).toEqual([task.id, copy.id]);
    expect(inbox.groups[0].tasks[0].subtasksDone).toBe(1);

    await c.deleteSubtask(a.id);
    detail = await c.getTask(task.id);
    expect(detail.subtasks).toHaveLength(1);

    const settings = await c.updateSettings({
      theme: "dark",
      colorTheme: null,
      syncTheme: null,
      panelWidth: 2000,
      showCompleted: null,
      editor: "cursor",
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
    expect(settings).toEqual({
      theme: "dark",
      colorTheme: "taido",
      syncTheme: true,
      panelWidth: 1000,
      showCompleted: false,
      editor: "cursor",
      claudePath: null,
      summarizeSessions: true,
      notifications: true,
      workspaceRoot: "/Users/user/Todo",
      tutorial: {
        status: "done",
        step: null,
        subjectId: null,
        taskId: null,
      },
      chronoCountsWaiting: false,
      defaultAgent: "claude",
      codexPath: null,
      agentChosen: true,
      voiceSpaceHold: true,
      language: null,
    });
  });

  it("keeps subtasks as child tasks with their own detail", async () => {
    const subject = await c.createSubject({
      name: "Globex",
      color: "violet",
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const parent = await c.createTask(
      input.task("Parente", { subjectId: subject.id }),
    );
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    await c.setTaskDue({ id: child.id, date: "2026-10-02", time: null });
    await c.setTaskPriority({ id: child.id, priority: 2 });

    const detail = await c.getTask(child.id);
    expect(detail).toMatchObject({
      title: "Enfant",
      parent: { id: parent.id, title: "Parente" },
      subtasks: [],
      priority: 2,
      subject: { id: subject.id },
      // Same folder as its parent.
      workdir: { path: "/tmp/globex" },
    });
    const [line] = (await c.getTask(parent.id)).subtasks;
    expect(line).toMatchObject({
      id: child.id,
      taskId: parent.id,
      text: "Enfant",
      priority: 2,
      ring: "human",
      due: { date: "2026-10-02" },
      openTerminals: 0,
    });
    // One level only.
    await expect(
      c.addSubtask({ taskId: child.id, text: "Petit-enfant" }),
    ).rejects.toMatchObject({ kind: "invalid" });

    // Never listed on its own, but under its parent's row.
    const view = await c.getView({
      kind: "subject",
      subjectId: subject.id,
      from: null,
      days: null,
    });
    const rows = view.groups.flatMap((g) => g.tasks);
    expect(rows.map((r) => r.id)).toEqual([parent.id]);
    expect(rows[0].children.map((r) => [r.id, r.parentId])).toEqual([
      [child.id, parent.id],
    ]);

    // Moving the parent moves the child; deleting it deletes the child, restoring restores.
    await c.moveTask({
      id: parent.id,
      subjectId: null,
      sectionId: null,
      index: null,
    });
    expect((await c.getTask(child.id)).subject).toBeNull();
    await c.deleteTask(parent.id);
    await expect(c.getTask(child.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await c.restoreTask(parent.id);
    expect((await c.getTask(child.id)).parent?.id).toBe(parent.id);
  });

  it("sets a priority from 1 to 4 and refuses other values", async () => {
    const task = await c.createTask(input.task("Urgente"));
    expect(task.priority).toBe(1);
    const changed = await c.setTaskPriority({ id: task.id, priority: 4 });
    expect(changed.priority).toBe(4);
    for (const priority of [0, 5, 2.5]) {
      await expect(
        c.setTaskPriority({ id: task.id, priority }),
      ).rejects.toMatchObject({ kind: "invalid" });
    }
    const inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(inbox.groups[0].tasks[0].priority).toBe(4);
  });

  it("refreshes the parent when a subtask changes", async () => {
    const parent = await c.createTask(input.task("Parente"));
    const child = await c.addSubtask({ taskId: parent.id, text: "Enfant" });
    const events: DataChanged[] = [];
    await backend.events.dataChanged.listen((e) => events.push(e.payload));
    await c.toggleSubtask(child.id);
    await c.setTaskPriority({ id: child.id, priority: 3 });
    for (const e of events) {
      expect(e.taskIds).toEqual(expect.arrayContaining([child.id, parent.id]));
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it("soft-deletes a subject with its tasks and restores them", async () => {
    const { subject } = await subjectWithSections();
    const kept = await c.createTask(
      input.task("A", { subjectId: subject.id, dueDate: "2026-10-01" }),
    );
    const alone = await c.createTask(
      input.task("Seule", { subjectId: subject.id }),
    );
    await c.deleteTask(alone.id);
    clock = new Date(2026, 9, 1, 10, 1);
    await c.deleteSubject(subject.id);
    expect(await c.listSubjects()).toEqual([]);
    expect((await c.getCounts()).today).toBe(0);
    await expect(c.getTask(kept.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(c.restoreTask(alone.id)).rejects.toMatchObject({
      kind: "not_found",
    });

    const back = await c.restoreSubject(subject.id);
    expect(back.openCount).toBe(1);
    expect((await c.getCounts()).today).toBe(1);
    await expect(c.getTask(alone.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await c.restoreTask(alone.id)).title).toBe("Seule");
    await expect(c.restoreSubject(subject.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("soft-deletes a task and restores it at its place", async () => {
    const a = await c.createTask(input.task("A"));
    await c.createTask(input.task("B"));
    await c.deleteTask(a.id);
    let inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(titles(inbox.groups[0].tasks)).toEqual(["B"]);
    expect((await c.getCounts()).inbox).toBe(1);
    await expect(c.deleteTask(a.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    await c.restoreTask(a.id);
    inbox = await c.getView({
      kind: "inbox",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(titles(inbox.groups[0].tasks)).toEqual(["A", "B"]);
  });

  it("creates projects without folder and rotates the palette", async () => {
    const colors = [];
    for (const name of ["Un", "Deux", "Trois"]) {
      const s = await c.createSubject({
        name,
        color: null,
        rootPath: null,
        parentId: null,
      });
      expect(s.rootPath).toBeNull();
      colors.push(s.color);
    }
    expect(colors).toEqual(["violet", "teal", "pink"]);
    const s = await c.createSubject({
      name: "Lié",
      color: "slate",
      rootPath: "/tmp/lie",
      parentId: null,
    });
    expect(
      (
        await c.createSubject({
          name: "X",
          color: null,
          rootPath: null,
          parentId: null,
        })
      ).color,
    ).toBe("violet");
    await expect(
      c.createSubject({
        name: "Rel",
        color: null,
        rootPath: "rel/dir",
        parentId: null,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });

    const t = await c.createTask(input.task("T", { subjectId: s.id }));
    expect(t.workdir?.path).toBe("/tmp/lie");
    const unlinked = await c.updateSubject({
      id: s.id,
      name: null,
      color: null,
      rootPath: "",
      parentId: null,
    });
    expect(unlinked.rootPath).toBeNull();
    expect((await c.getTask(t.id)).workdir).toBeNull();
  });

  it("reschedules overdue tasks to today", async () => {
    const late = await c.createTask(
      input.task("En retard", { dueDate: "2026-09-28", dueTime: "08:30" }),
    );
    await c.createTask(input.task("Demain", { dueDate: "2026-10-02" }));
    expect(await c.rescheduleOverdue()).toBe(1);
    const detail = await c.getTask(late.id);
    expect(detail.due).toEqual({
      date: "2026-10-01",
      time: "08:30",
      overdue: false,
    });
    const view = await c.getView({
      kind: "today",
      subjectId: null,
      from: null,
      days: null,
    });
    expect(view.groups.map((g) => g.key.type)).toEqual(["today_rest"]);
    expect(await c.rescheduleOverdue()).toBe(0);
  });

  it("validates paths to open", async () => {
    await expect(
      c.openPath({ path: "relative", with: null, editor: null }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(
      await c.openPath({ path: "/tmp", with: "finder", editor: null }),
    ).toBeNull();
  });
  it("finds Claude Code, or not, as configured", async () => {
    expect(await c.checkAgent("claude")).toMatchObject({
      path: MOCK_CLAUDE_PATH,
      loggedIn: true,
    });
    await c.updateSettings({
      theme: null,
      colorTheme: null,
      syncTheme: null,
      panelWidth: null,
      showCompleted: null,
      editor: null,
      claudePath: "/usr/local/bin/claude",
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
    expect((await c.checkAgent("claude")).path).toBe("/usr/local/bin/claude");
    expect((await c.getAppStatus()).claude.path).toBe("/usr/local/bin/claude");

    backend.state.claude = { found: true, loggedIn: false };
    expect((await c.checkAgent("claude")).loggedIn).toBe(false);

    backend.state.claude = { found: false, loggedIn: null };
    expect(await c.checkAgent("claude")).toEqual({
      path: null,
      version: null,
      loggedIn: null,
    });
    const subject = await c.createSubject({
      name: "Globex",
      color: null,
      rootPath: "/tmp/globex",
      parentId: null,
    });
    const t = await c.createTask(
      input.task("Claude", { subjectId: subject.id }),
    );
    await expect(
      c.openTerminal({
        taskId: t.id,
        kind: "agent",
        agent: null,
        command: null,
        initialPrompt: null,
        permissionMode: null,
        addTaskContext: true,
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ kind: "claude_missing" });
  });

  it("searches tasks by title or project, open ones first", async () => {
    const subject = await c.createSubject({
      name: "Écoles",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const done = await c.createTask(
      input.task("Relancer la mairie", { subjectId: subject.id }),
    );
    await c.setTaskCompleted({ id: done.id, completed: true });
    await c.createTask(input.task("Relancer Dupont"));
    expect((await c.searchTasks("relancer")).map((h) => h.title)).toEqual([
      "Relancer Dupont",
      "Relancer la mairie",
    ]);
    const [hit] = await c.searchTasks("ecoles");
    expect(hit).toMatchObject({
      title: "Relancer la mairie",
      completed: true,
      ring: "completed",
      subject: { id: subject.id, name: "Écoles" },
    });
    expect(await c.searchTasks("   ")).toEqual([]);
  });
});
