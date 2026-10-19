import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TaskDetail,
  TaskLine,
  TaskRow,
  TaskStateChanged,
  ViewModel,
} from "../bindings";
import { mockBackend } from "./ipc";
import {
  applyTaskState,
  createQueryClient,
  INVALIDATION_THROTTLE_MS,
  queryKeys,
  subscribeToCoreEvents,
} from "./queries";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const row = (id: string): TaskRow => ({
  id,
  title: id,
  subject: null,
  subjectId: null,
  sectionId: null,
  ring: "human",
  line: null,
  hasDescription: false,
  due: null,
  openTerminals: 1,
  subtasksDone: 0,
  subtasksTotal: 0,
  completedAt: null,
  position: 1,
  priority: 1,
  parentId: null,
  children: [],
  chrono: null,
  attachmentCount: 0,
  blocksCount: 0,
  blockedBy: null,
  blockedByCount: 0,
  relatedCount: 0,
});

const view = (rows: TaskRow[]): ViewModel => ({
  kind: "today",
  subject: null,
  groups: [
    {
      key: { type: "today_rest" },
      showHeader: false,
      tasks: rows,
      addTarget: null,
    },
  ],
  openCount: rows.length,
  completed: [],
  today: "2026-10-01",
});

const detail = (id: string): TaskDetail => ({
  id,
  title: id,
  description: "Une note",
  subject: null,
  section: null,
  due: null,
  workdir: null,
  workdirOverride: null,
  gitBranch: null,
  ring: "human",
  line: {
    kind: "description",
    agent: null,
    text: "Une note",
    at: null,
    tone: "muted",
  },
  ringSince: null,
  subtasks: [],
  completedAt: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  terminals: [],
  sessions: [],
  priority: 1,
  parent: null,
  time: { chrono: { seconds: 0, runningSince: null }, segments: [] },
  attachments: [],
  relations: { blocks: [], blockedBy: [], related: [] },
});

const waitingLine: TaskLine = {
  kind: "waiting_question",
  agent: null,
  text: "On continue ?",
  at: null,
  tone: "waiting",
};

const change = (over: Partial<TaskStateChanged> = {}): TaskStateChanged => ({
  taskId: "t1",
  subjectId: null,
  ring: "waiting",
  line: waitingLine,
  at: "2026-10-01T08:30:00.000Z",
  ...over,
});

describe("task-state-changed", () => {
  let unsubscribe: () => void = () => {};

  beforeEach(() => {
    backend().reset({ seed: false });
  });
  afterEach(() => unsubscribe());

  it("patches the row in every cached view and the task detail", () => {
    const client = createQueryClient();
    client.setQueryData(
      queryKeys.view("today", null),
      view([row("t1"), row("t2")]),
    );
    client.setQueryData(queryKeys.view("subject", "s1"), view([row("t1")]));
    client.setQueryData(queryKeys.task("t1"), detail("t1"));

    applyTaskState(client, change());

    const today = client.getQueryData<ViewModel>(queryKeys.view("today", null));
    expect(today?.groups[0].tasks[0]).toMatchObject({
      ring: "waiting",
      line: waitingLine,
    });
    expect(today?.groups[0].tasks[1].ring).toBe("human");
    const subject = client.getQueryData<ViewModel>(
      queryKeys.view("subject", "s1"),
    );
    expect(subject?.groups[0].tasks[0].ring).toBe("waiting");
    expect(client.getQueryData<TaskDetail>(queryKeys.task("t1"))).toMatchObject(
      {
        ring: "waiting",
        ringSince: "2026-10-01T08:30:00.000Z",
        line: waitingLine,
      },
    );
  });

  it("moves « depuis… » only when the ring changes", () => {
    const client = createQueryClient();
    const since = "2026-10-01T08:00:00.000Z";
    client.setQueryData(queryKeys.task("t1"), {
      ...detail("t1"),
      ring: "working",
      ringSince: since,
    });
    // A new tool in Working: same ring, the change's instant is not the state's.
    applyTaskState(
      client,
      change({
        ring: "working",
        line: {
          kind: "working",
          agent: null,
          text: "Lecture a.rs",
          at: null,
          tone: "muted",
        },
      }),
    );
    const task = client.getQueryData<TaskDetail>(queryKeys.task("t1"));
    expect(task?.ringSince).toBe(since);
    expect(task?.line?.text).toBe("Lecture a.rs");
    applyTaskState(client, change());
    expect(
      client.getQueryData<TaskDetail>(queryKeys.task("t1"))?.ringSince,
    ).toBe("2026-10-01T08:30:00.000Z");
  });

  it("patches a subtask's dot in its parent's panel", () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.task("p1"), {
      ...detail("p1"),
      subtasks: [
        {
          id: "t1",
          taskId: "p1",
          text: "Enfant",
          done: false,
          position: 1,
          ring: "human",
          priority: 1,
          due: null,
          openTerminals: 1,
        },
      ],
    });
    applyTaskState(client, change());
    const parent = client.getQueryData<TaskDetail>(queryKeys.task("p1"));
    expect(parent?.subtasks[0].ring).toBe("waiting");
    // The parent's own ring comes from the core's batch for the parent.
    expect(parent?.ring).toBe("human");
  });

  it("keeps the panel's own line when the state has none", () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.task("t1"), detail("t1"));
    applyTaskState(client, change({ ring: "human", line: null }));
    expect(
      client.getQueryData<TaskDetail>(queryKeys.task("t1"))?.line?.kind,
    ).toBe("description");
  });

  it("is applied at once when the core emits the event", async () => {
    const client = createQueryClient();
    unsubscribe = subscribeToCoreEvents(client);
    client.setQueryData(queryKeys.view("today", null), view([row("t1")]));
    await backend().events.taskStateChanged.emit(change({ ring: "done" }));
    expect(
      client.getQueryData<ViewModel>(queryKeys.view("today", null))?.groups[0]
        .tasks[0].ring,
    ).toBe("done");
  });
});

describe("data-changed with the notes scope", () => {
  let unsubscribe: () => void = () => {};
  beforeEach(() => {
    backend().reset({ seed: false });
    vi.useFakeTimers();
  });
  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  it("refetches the notebook queries and leaves the tasks alone", async () => {
    const client = createQueryClient();
    unsubscribe = subscribeToCoreEvents(client);
    client.setQueryData(queryKeys.notebook("s1"), { subjectId: "s1" });
    client.setQueryData(queryKeys.task("t1"), detail("t1"));
    await backend().events.dataChanged.emit({
      scopes: ["notes"],
      taskIds: null,
    });
    vi.advanceTimersByTime(INVALIDATION_THROTTLE_MS + 1);
    expect(client.getQueryState(queryKeys.notebook("s1"))?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(queryKeys.task("t1"))?.isInvalidated).toBe(
      false,
    );
  });
});

describe("notebook search keys (m7)", () => {
  it("sit under the notebooks key, so the `notes` scope refreshes the hits", () => {
    for (const key of [
      queryKeys.searchNotes("mails"),
      queryKeys.searchNotes("mails", "s1"),
    ]) {
      expect(key.slice(0, queryKeys.notebooks.length)).toEqual([
        ...queryKeys.notebooks,
      ]);
    }
    expect(queryKeys.searchNotes("a", "s1")).not.toEqual(
      queryKeys.searchNotes("a"),
    );
  });
});
