import { describe, expect, it, vi } from "vitest";
import { settingsPatch } from "../lib/settingsPatch";
import {
  type Change,
  SETTING_APPEARANCE,
  SETTING_INBOX_POSITION,
} from "../lib/sync-proto";
import {
  attachment,
  boardColumn,
  makePhone,
  noteAttachment,
  noteGroup,
  notePage,
  relation,
  section,
  setting,
  subject,
  task,
  timeSegment,
  tombstone,
} from "./test/helpers";

const S1 = "2026-10-04T09:00:00.000Z";
const S2 = "2026-10-04T09:00:01.000Z";

describe("apply (docs/SYNC.md § 2.5)", () => {
  it("ignores the rows of an entity it does not know (a later protocol's)", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      {
        entity: "comment",
        id: "c-1",
        updated_at: S1,
        device_id: "mac",
        data: { text: "?" },
      } as unknown as Change,
      subject("p", S1),
    ]);
    expect(r.applied).toBe(1);
    expect(r.parked).toBe(0);
    expect(Object.keys(backend.parked)).toEqual([]);
    expect(Object.keys(backend.snapshot)).toEqual(["subject:p"]);
  });

  it("applies Kanban columns, time segments and relations (V2.8), never queued back", async () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      relation("rel-1", "a", "b", S1),
      timeSegment("seg-1", "a", S1, { ended_at: S2, stop_reason: "waiting" }),
      timeSegment("seg-2", "a", S2),
      task("a", S1, { subject_id: "p", board_column_id: "col-p-2" }),
      task("b", S1, { subject_id: "p" }),
      boardColumn("col-p-2", "p", S1, { name: "À valider", position: 2 }),
      boardColumn("col-inbox-0", null, S1, { name: "À faire" }),
      subject("p", S1),
    ]);
    expect(r).toMatchObject({ applied: 8, parked: 0 });
    expect(backend.board.columns.map((c) => [c.id, c.subjectId])).toEqual([
      ["col-p-2", "p"],
      ["col-inbox-0", null],
    ]);
    // A pulled segment has no session here: a running one belongs to its Mac.
    expect(
      backend.chrono.segments.map((x) => [x.id, x.endedAt, x.agentSessionId]),
    ).toEqual([
      ["seg-1", S2, null],
      ["seg-2", null, null],
    ]);
    expect(backend.links.relations).toMatchObject([
      { id: "rel-1", from: "a", to: "b", kind: "blocks", deletedAt: null },
    ]);
    // The snapshot holds the wire data, in the server's field order.
    expect(backend.snapshot["time_segment:seg-1"]).toEqual({
      stamp: S1,
      json: JSON.stringify({
        task_id: "a",
        source: "auto",
        started_at: S1,
        ended_at: S2,
        stop_reason: "waiting",
        note: "",
        created_at: S1,
        deleted_at: null,
      }),
    });
    expect(backend.snapshot["board_column:col-p-2"].json).toBe(
      JSON.stringify({
        subject_id: "p",
        name: "À valider",
        position: 2,
        is_done: false,
        created_at: S1,
      }),
    );
    expect(backend.snapshot["relation:rel-1"].json).toBe(
      JSON.stringify({
        from_task_id: "a",
        to_task_id: "b",
        kind: "blocks",
        created_at: S1,
        deleted_at: null,
      }),
    );
    backend.diff();
    expect(backend.outbox).toEqual({});
    const detail = await backend.commands.getTask("a");
    expect(detail.time.chrono).toEqual({ seconds: 1, runningSince: S2 });
    expect(detail.relations.blocks.map((x) => x.taskId)).toEqual(["b"]);
    const board = await backend.commands.getBoard("p");
    expect(board.columns.map((c) => c.id)).toEqual(["col-p-2"]);
    expect(board.columns[0].cards.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("parks a column, a segment or a relation until what it hangs on is here", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      boardColumn("col-p-0", "p", S1),
      timeSegment("seg-1", "a", S1, { ended_at: S1 }),
      relation("rel-1", "a", "b", S1),
      relation("rel-2", "b", "a", S1, { kind: "relates_to" }),
      task("a", S1),
    ]);
    expect(r).toMatchObject({ applied: 2, parked: 3 });
    expect(Object.keys(backend.parked).sort()).toEqual([
      "board_column:col-p-0",
      "relation:rel-1",
      "relation:rel-2",
    ]);
    backend.applyPulled([subject("p", S1), task("b", S1)]);
    expect(backend.parked).toEqual({});
    expect(backend.board.columns.map((c) => c.id)).toEqual(["col-p-0"]);
    expect(backend.links.relations.map((x) => x.id)).toEqual([
      "rel-1",
      "rel-2",
    ]);
  });

  it("a task never waits for its Kanban column: it keeps the id as it came", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      task("t", S1, { board_column_id: "col-later" }),
    ]);
    expect(r).toMatchObject({ applied: 1, parked: 0 });
    expect(backend.state.tasks[0].boardColumnId).toBe("col-later");
  });

  it("review point 5: a task tombstone deletes its segments and relations (either side), as local tombstones unless covered", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      task("t", S1),
      task("child", S1, { parent_id: "t" }),
      task("other", S1),
      timeSegment("seg-1", "t", S1, { ended_at: S1 }),
      timeSegment("seg-2", "child", S1, { ended_at: S1 }),
      timeSegment("seg-3", "t", S1, { ended_at: S1 }),
      timeSegment("seg-other", "other", S1, { ended_at: S1 }),
      relation("rel-from", "t", "other", S1),
      relation("rel-to", "other", "child", S1, { kind: "relates_to" }),
    ]);
    const r = backend.applyPulled([
      tombstone("time_segment", "seg-3", S2),
      tombstone("task", "t", S2),
    ]);
    expect(r.cascaded).toBe(5);
    expect(backend.chrono.segments.map((x) => x.id)).toEqual(["seg-other"]);
    expect(backend.links.relations).toEqual([]);
    expect(backend.state.tasks.map((x) => x.id)).toEqual(["other"]);
    for (const k of [
      "time_segment:seg-1",
      "time_segment:seg-2",
      "relation:rel-from",
      "relation:rel-to",
      "task:child",
    ]) {
      expect(backend.outbox[k]?.purged).toBe(true);
      expect(backend.snapshot[k]).toBeUndefined();
    }
    expect(backend.outbox["time_segment:seg-3"]).toBeUndefined();
    expect(backend.outbox["task:t"]).toBeUndefined();
  });

  it("a project tombstone deletes its columns (sub-projects' too) as local tombstones", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      subject("sub", S1, { parent_id: "p" }),
      boardColumn("col-p-0", "p", S1),
      boardColumn("col-sub-0", "sub", S1),
      boardColumn("col-inbox-0", null, S1),
    ]);
    backend.applyPulled([tombstone("subject", "p", S2)]);
    expect(backend.board.columns.map((c) => c.id)).toEqual(["col-inbox-0"]);
    expect(backend.outbox["board_column:col-p-0"]?.purged).toBe(true);
    expect(backend.outbox["board_column:col-sub-0"]?.purged).toBe(true);
    expect(backend.outbox["board_column:col-inbox-0"]).toBeUndefined();
  });

  it("a column tombstone moves its tasks to no column, silently", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      boardColumn("col-x", "p", S1),
      task("t", S1, { subject_id: "p", board_column_id: "col-x" }),
    ]);
    const r = backend.applyPulled([tombstone("board_column", "col-x", S2)]);
    expect(r).toMatchObject({ applied: 1, cascaded: 0 });
    expect(backend.board.columns).toEqual([]);
    expect(backend.state.tasks[0].boardColumnId).toBeNull();
    expect(JSON.parse(backend.snapshot["task:t"].json).board_column_id).toBe(
      null,
    );
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("a duplicate relation (either direction) keeps the lowest id, the other is deleted as a local edit", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      task("a", S1),
      task("b", S1),
      relation("rel-2", "a", "b", S1, { kind: "relates_to" }),
    ]);
    const r = backend.applyPulled([
      relation("rel-1", "b", "a", S2, { kind: "relates_to" }),
      // Another kind is another relation.
      relation("rel-3", "a", "b", S2),
    ]);
    expect(r.corrected).toBe(1);
    backend.diff();
    expect(Object.keys(backend.outbox)).toEqual(["relation:rel-2"]);
    expect(backend.outbox["relation:rel-2"].changed_at > S1).toBe(true);
    expect(
      backend.links.relations
        .filter((x) => x.deletedAt === null)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["rel-1", "rel-3"]);
  });

  it("applies attachment rows (V2.7 bis): shown on the task, never queued back", async () => {
    const { backend } = makePhone();
    const sha256 = "a".repeat(64);
    const r = backend.applyPulled([
      attachment("att-2", "t", S1, {
        file_name: "plan.png",
        mime_type: "image/png",
        size: 12,
      }),
      attachment("att-1", "t", S1, { file_name: "devis.pdf", sha256 }),
      task("t", S1),
    ]);
    expect(r).toMatchObject({ applied: 3, parked: 0 });
    const detail = await backend.commands.getTask("t");
    expect(
      detail.attachments.map((a) => [a.fileName, a.isImage, a.size]),
    ).toEqual([
      ["plan.png", true, 12],
      ["devis.pdf", false, 3],
    ]);
    expect(detail.attachments[0]).toMatchObject({
      mimeType: "image/png",
      addedAt: S1,
      exists: true,
      remote: "none",
    });
    // The snapshot is the wire data: `sha256` left out when unknown, like the server.
    expect(JSON.parse(backend.snapshot["attachment:att-1"].json)).toEqual({
      task_id: "t",
      file_name: "devis.pdf",
      mime_type: "application/pdf",
      size: 3,
      sha256,
      created_at: S1,
      deleted_at: null,
    });
    expect(backend.snapshot["attachment:att-2"].json).not.toContain("sha256");
    backend.diff();
    expect(backend.outbox).toEqual({});
    expect(
      (
        await backend.commands.getView({
          kind: "inbox",
          subjectId: null,
          from: null,
          days: null,
        })
      ).groups
        .flatMap((g) => g.tasks)
        .find((x) => x.id === "t")?.attachmentCount,
    ).toBe(2);
  });

  it("parks an attachment whose task is missing, and applies it when the task arrives", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([attachment("att-1", "t", S1)]);
    expect(r).toMatchObject({ applied: 0, parked: 1 });
    expect(Object.keys(backend.parked)).toEqual(["attachment:att-1"]);
    backend.applyPulled([task("t", S1)]);
    expect(backend.links.attachments.map((a) => a.id)).toEqual(["att-1"]);
    expect(backend.parked).toEqual({});
  });

  it("a task tombstone deletes its attachments, queued as tombstones unless covered", async () => {
    const { backend } = makePhone();
    backend.applyPulled([
      task("t", S1),
      task("child", S1, { parent_id: "t" }),
      attachment("att-1", "t", S1),
      attachment("att-2", "child", S1),
      attachment("att-3", "t", S1),
    ]);
    backend.applyPulled([
      tombstone("attachment", "att-3", S2),
      tombstone("task", "t", S2),
    ]);
    expect(backend.links.attachments).toEqual([]);
    expect(backend.state.tasks).toEqual([]);
    expect(backend.outbox["attachment:att-1"].purged).toBe(true);
    expect(backend.outbox["attachment:att-2"].purged).toBe(true);
    expect(backend.outbox["attachment:att-3"]).toBeUndefined();
    expect(backend.snapshot["attachment:att-3"]).toBeUndefined();
  });

  it("a soft-deleted attachment pulled leaves the task's list", async () => {
    const { backend } = makePhone();
    backend.applyPulled([task("t", S1), attachment("att-1", "t", S1)]);
    backend.applyPulled([attachment("att-1", "t", S2, { deleted_at: S2 })]);
    expect((await backend.commands.getTask("t")).attachments).toEqual([]);
    expect(
      JSON.parse(backend.snapshot["attachment:att-1"].json).deleted_at,
    ).toBe(S2);
  });

  it("keeps a pulled group and a task's Kanban column in the state and the snapshot", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      subject("g", S1, { is_group: true }),
      subject("p", S1, { parent_id: "g" }),
      task("t", S1, { subject_id: "p", board_column_id: "col-p-2" }),
    ]);
    expect(r.applied).toBe(3);
    expect(backend.state.subjects.find((x) => x.id === "g")?.isGroup).toBe(
      true,
    );
    expect(backend.state.subjects.find((x) => x.id === "p")?.isGroup).toBe(
      false,
    );
    expect(backend.state.tasks[0].boardColumnId).toBe("col-p-2");
    expect(JSON.parse(backend.snapshot["subject:g"].json).is_group).toBe(true);
    expect(JSON.parse(backend.snapshot["task:t"].json).board_column_id).toBe(
      "col-p-2",
    );
    // Applied rows are never queued back.
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("applies groups in order and retries inside a group", () => {
    const { backend } = makePhone();
    // C → B → A in one response: C and B wait for their parents.
    const r = backend.applyPulled([
      task("child", S1, { parent_id: "parent", subject_id: "p" }),
      subject("c", S1, { parent_id: "b" }),
      subject("b", S1, { parent_id: "a" }),
      task("parent", S1, { subject_id: "p", section_id: "sec" }),
      section("sec", "p", S1),
      subject("a", S1),
      subject("p", S1),
    ]);
    expect(r.parked).toBe(0);
    expect(r.applied).toBe(7);
    const byId = new Map(backend.state.subjects.map((s) => [s.id, s]));
    // N2: c (child of a child) moves up to a, a correction queued as a local edit.
    expect(byId.get("c")?.parentId).toBe("a");
    backend.emitDataChanged(["subjects", "tasks"]);
    expect(Object.keys(backend.outbox).sort()).toEqual([
      "subject:c",
      "task:child",
    ]);
    expect(r.corrected).toBe(2);
    const child = backend.state.tasks.find((t) => t.id === "child");
    // N5: the child shares its parent's place.
    expect(child?.sectionId).toBe("sec");
  });

  it("parks a child whose parent is missing, and applies it when the parent arrives", () => {
    const { backend } = makePhone();
    let r = backend.applyPulled([
      task("kid", S1, { parent_id: "dad" }),
      section("sec", "nowhere", S1),
    ]);
    expect(r.parked).toBe(2);
    expect(backend.state.tasks).toEqual([]);
    expect(Object.keys(backend.parked).sort()).toEqual([
      "section:sec",
      "task:kid",
    ]);
    r = backend.applyPulled([task("dad", S2)]);
    expect(backend.state.tasks.map((t) => t.id).sort()).toEqual(["dad", "kid"]);
    expect(Object.keys(backend.parked)).toEqual(["section:sec"]);
    // A newer pulled version replaces the parked one.
    backend.applyPulled([tombstone("section", "sec", S2)]);
    expect(backend.parked).toEqual({});
  });

  it("applies a task with a missing section without its section", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      task("t", S1, { subject_id: "p", section_id: "ghost" }),
    ]);
    expect(backend.state.tasks[0].sectionId).toBeNull();
    expect(backend.outbox).toEqual({});
  });

  it("re-applies a task once its section arrives in a later page", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      task("t", S1, { subject_id: "p", section_id: "sec" }),
    ]);
    expect(backend.state.tasks[0].sectionId).toBeNull();
    expect(Object.keys(backend.parked)).toEqual(["task:t"]);
    // Still waiting: nothing is written again.
    expect(backend.applyPulled([]).applied).toBe(0);
    const r = backend.applyPulled([section("sec", "p", S2)]);
    expect(r.applied).toBe(2);
    expect(backend.state.tasks[0].sectionId).toBe("sec");
    expect(backend.parked).toEqual({});
    backend.emitDataChanged(["subjects", "tasks"]);
    expect(backend.outbox).toEqual({});
  });

  it("drops a parked row whose task was edited locally meanwhile", async () => {
    const { backend } = makePhone();
    backend.applyPulled([subject("a", S1), task("t", S1, { subject_id: "a" })]);
    // The server's newer version moves the task to project b, not here yet: parked.
    backend.applyPulled([task("t", S2, { subject_id: "b", title: "server" })]);
    expect(Object.keys(backend.parked)).toEqual(["task:t"]);
    await backend.commands.updateTask({
      id: "t",
      title: null,
      description: "note du téléphone",
    });
    expect(backend.outbox["task:t"]).toBeDefined();
    backend.applyPulled([subject("b", S2)]);
    expect(backend.parked).toEqual({});
    expect(backend.state.tasks[0]).toMatchObject({
      subjectId: "a",
      description: "note du téléphone",
    });
    expect(JSON.parse(backend.snapshot["task:t"].json).description).toBe(
      "note du téléphone",
    );
  });

  it("drops a parked row whose task was deleted locally meanwhile", async () => {
    const { backend } = makePhone();
    backend.applyPulled([subject("a", S1), task("t", S1, { subject_id: "a" })]);
    backend.applyPulled([task("t", S2, { subject_id: "b" })]);
    backend.state.tasks = [];
    backend.emitDataChanged(["tasks"]);
    expect(backend.outbox["task:t"]?.purged).toBe(true);
    backend.applyPulled([subject("b", S2)]);
    expect(backend.state.tasks).toEqual([]);
    expect(backend.snapshot["task:t"]).toBeUndefined();
    expect(backend.parked).toEqual({});
  });

  it("keeps local-only fields when a new version arrives", () => {
    const { backend } = makePhone();
    backend.applyPulled([subject("p", S1), task("t", S1, { subject_id: "p" })]);
    backend.state.subjects[0].rootPath = "/Users/user/Todo/p";
    backend.state.tasks[0].workdirOverride = "/tmp/x";
    backend.applyPulled([
      subject("p", S2, { name: "renamed" }),
      task("t", S2, { subject_id: "p", title: "new" }),
    ]);
    expect(backend.state.subjects[0]).toMatchObject({
      name: "renamed",
      rootPath: "/Users/user/Todo/p",
    });
    expect(backend.state.tasks[0]).toMatchObject({
      title: "new",
      workdirOverride: "/tmp/x",
    });
  });

  it("a project tombstone deletes its local tasks added offline and queues their tombstones", async () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      task("known", S1, { subject_id: "p" }),
    ]);
    const offline = await backend.commands.createTask({
      title: "hors ligne",
      description: null,
      subjectId: "p",
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    backend.applyPulled([
      tombstone("task", "known", S2),
      tombstone("subject", "p", S2),
    ]);
    expect(backend.state.subjects).toEqual([]);
    expect(backend.state.tasks).toEqual([]);
    expect(backend.outbox[`task:${offline.id}`].purged).toBe(true);
    expect(backend.outbox["task:known"]).toBeUndefined();
    expect(backend.snapshot["subject:p"]).toBeUndefined();
  });

  it("ignores a tombstone of an unknown row", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([tombstone("task", "nope", S1)]);
    expect(r.applied).toBe(0);
  });

  it("a section tombstone leaves its tasks without section", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      section("sec", "p", S1),
      task("t", S1, { subject_id: "p", section_id: "sec" }),
    ]);
    backend.applyPulled([tombstone("section", "sec", S2)]);
    expect(backend.state.sections).toEqual([]);
    expect(backend.state.tasks[0].sectionId).toBeNull();
    expect(backend.outbox).toEqual({});
  });

  it("N1 breaks a project cycle at its oldest member", () => {
    const { backend } = makePhone();
    backend.applyPulled([subject("x", S1), subject("y", S2)]);
    backend.state.subjects[0].parentId = "y";
    backend.state.subjects[1].parentId = "x";
    backend.applyPulled([]);
    expect(backend.state.subjects.find((s) => s.id === "x")?.parentId).toBe(
      null,
    );
    expect(backend.state.subjects.find((s) => s.id === "y")?.parentId).toBe(
      "x",
    );
  });

  it("N3–N4 break task cycles and flatten child tasks", () => {
    const { backend } = makePhone();
    backend.applyPulled([task("a", S1), task("b", S2), task("c", S2)]);
    const [a, b, c] = backend.state.tasks;
    a.parentId = "b";
    b.parentId = "a";
    c.parentId = "b";
    backend.applyPulled([]);
    expect(a.parentId).toBeNull();
    expect(b.parentId).toBe("a");
    expect(c.parentId).toBe("a");
  });

  it("N6 drops a section of another project", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      subject("q", S1),
      section("sec", "q", S1),
      task("t", S1, { subject_id: "p" }),
    ]);
    backend.state.tasks[0].sectionId = "sec";
    backend.applyPulled([]);
    expect(backend.state.tasks[0].sectionId).toBeNull();
  });

  it("N7–N8: delete wins, and each correction is queued", () => {
    const { backend } = makePhone();
    const deleted = "2026-10-04T08:00:00.000Z";
    backend.applyPulled([
      subject("p", S1),
      subject("sub", S1, { parent_id: "p" }),
      task("t", S1, { subject_id: "sub" }),
      task("kid", S1, { subject_id: "sub", parent_id: "t" }),
    ]);
    backend.applyPulled([subject("p", S2, { deleted_at: deleted })]);
    expect(backend.state.subjects.every((s) => s.deletedAt === deleted)).toBe(
      true,
    );
    expect(backend.state.tasks.every((t) => t.deletedAt === deleted)).toBe(
      true,
    );
    // The corrections leave through the diff.
    backend.emitDataChanged(["subjects", "tasks"]);
    expect(Object.keys(backend.outbox).sort()).toEqual([
      "subject:sub",
      "task:kid",
      "task:t",
    ]);
  });

  it("is idempotent on a normalised state", () => {
    const { backend } = makePhone();
    backend.applyPulled([subject("p", S1), task("t", S1, { subject_id: "p" })]);
    expect(backend.applyPulled([]).corrected).toBe(0);
  });
});

describe("apply: the project notebook (docs/SYNC.md § 0.5–0.6)", () => {
  const sha = "a".repeat(64);

  it("applies groups, pages and page images in order, never queued back", async () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      noteAttachment("img-1", "pg-1", S1, { sha256: sha }),
      notePage("pg-1", "p", S1, {
        group_id: "g-1",
        title: "Style des mails",
        body: "==x== ![[file:img-1|50%]]",
        pinned_at: S2,
        position: 3,
      }),
      noteGroup("g-1", "p", S1, { name: "Décisions" }),
      subject("p", S1),
    ]);
    expect(r).toMatchObject({ applied: 4, parked: 0 });
    expect(backend.notes.groups).toMatchObject([
      { id: "g-1", subjectId: "p", name: "Décisions" },
    ]);
    expect(backend.notes.pages).toMatchObject([
      {
        id: "pg-1",
        groupId: "g-1",
        kind: "page",
        title: "Style des mails",
        pinnedAt: S2,
        deletedAt: null,
      },
    ]);
    // The image is the page's, not a task's.
    expect(backend.links.attachments).toMatchObject([
      {
        id: "img-1",
        notePageId: "pg-1",
        taskId: "",
        sha256: sha,
        file: "missing",
      },
    ]);
    expect((await backend.commands.listNoteAttachments("pg-1")).length).toBe(1);
    // The snapshot holds the wire data, in the server's field order.
    expect(backend.snapshot["note_page:pg-1"]).toEqual({
      stamp: S1,
      json: JSON.stringify({
        subject_id: "p",
        group_id: "g-1",
        kind: "page",
        title: "Style des mails",
        body: "==x== ![[file:img-1|50%]]",
        source_task_id: null,
        pinned_at: S2,
        position: 3,
        created_at: S1,
        deleted_at: null,
      }),
    });
    expect(backend.snapshot["note_group:g-1"].json).toBe(
      JSON.stringify({
        subject_id: "p",
        name: "Décisions",
        position: 1,
        created_at: S1,
      }),
    );
    expect(backend.snapshot["note_attachment:img-1"].json).toBe(
      JSON.stringify({
        note_page_id: "pg-1",
        file_name: "img-1.png",
        mime_type: "image/png",
        size: 3,
        sha256: sha,
        created_at: S1,
        deleted_at: null,
      }),
    );
    backend.diff();
    expect(backend.outbox).toEqual({});
    expect((await backend.commands.notebook("p")).pinned[0].id).toBe("pg-1");
  });

  it("parks a group, a page or an image until what it hangs on is here", () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      noteGroup("g-1", "p", S1),
      notePage("pg-1", "p", S1),
      noteAttachment("img-1", "pg-2", S1),
    ]);
    expect(r).toMatchObject({ applied: 0, parked: 3 });
    expect(Object.keys(backend.parked).sort()).toEqual([
      "note_attachment:img-1",
      "note_group:g-1",
      "note_page:pg-1",
    ]);
    backend.applyPulled([subject("p", S1)]);
    expect(backend.notes.groups.map((g) => g.id)).toEqual(["g-1"]);
    expect(backend.notes.pages.map((x) => x.id)).toEqual(["pg-1"]);
    // The image still waits for its page.
    expect(Object.keys(backend.parked)).toEqual(["note_attachment:img-1"]);
    backend.applyPulled([notePage("pg-2", "p", S2)]);
    expect(backend.links.attachments.map((a) => a.id)).toEqual(["img-1"]);
    expect(backend.parked).toEqual({});
  });

  it("N11: a page of an unknown group is applied without it and waits for it", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      notePage("pg-1", "p", S1, { group_id: "ghost", source_task_id: "t-x" }),
    ]);
    // « Sans groupe » (and no source task) here; never lost.
    expect(backend.notes.pages[0]).toMatchObject({
      groupId: null,
      sourceTaskId: null,
    });
    expect(Object.keys(backend.parked)).toEqual(["note_page:pg-1"]);
    expect(backend.outbox).toEqual({});
    // Still waiting: nothing is written again.
    expect(backend.applyPulled([]).applied).toBe(0);
    // The group and the task arrive later: the page joins them.
    const r = backend.applyPulled([
      noteGroup("ghost", "p", S2),
      task("t-x", S2, { subject_id: "p" }),
    ]);
    expect(r.applied).toBe(3);
    expect(backend.notes.pages[0]).toMatchObject({
      groupId: "ghost",
      sourceTaskId: "t-x",
    });
    expect(backend.parked).toEqual({});
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("N11: a page in a group of another project leaves it, as a local edit", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      subject("q", S1),
      noteGroup("g-q", "q", S1),
      notePage("pg-1", "p", S1, { group_id: "g-q" }),
    ]);
    expect(backend.notes.pages[0].groupId).toBeNull();
    backend.diff();
    expect(backend.outbox["note_page:pg-1"]).toMatchObject({ purged: false });
    expect(
      JSON.parse(backend.snapshot["note_page:pg-1"].json).group_id,
    ).toBeNull();
  });

  it("a group tombstone leaves its pages without group, silently", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      noteGroup("g-1", "p", S1),
      notePage("pg-1", "p", S1, { group_id: "g-1" }),
    ]);
    backend.applyPulled([tombstone("note_group", "g-1", S2)]);
    expect(backend.notes.groups).toEqual([]);
    expect(backend.notes.pages[0].groupId).toBeNull();
    expect(backend.outbox).toEqual({});
    expect(backend.snapshot["note_group:g-1"]).toBeUndefined();
    backend.diff();
    expect(backend.outbox).toEqual({});
  });

  it("a page tombstone deletes its images, queued as tombstones unless covered", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      notePage("pg-1", "p", S1),
      noteAttachment("img-1", "pg-1", S1),
      noteAttachment("img-2", "pg-1", S1),
    ]);
    backend.applyPulled([
      tombstone("note_attachment", "img-2", S2),
      tombstone("note_page", "pg-1", S2),
    ]);
    expect(backend.notes.pages).toEqual([]);
    expect(backend.links.attachments).toEqual([]);
    expect(backend.outbox["note_attachment:img-1"].purged).toBe(true);
    expect(backend.outbox["note_attachment:img-2"]).toBeUndefined();
  });

  it("a project tombstone takes its notebook as local tombstones", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      noteGroup("g-1", "p", S1),
      notePage("pg-1", "p", S1, { group_id: "g-1" }),
      noteAttachment("img-1", "pg-1", S1),
    ]);
    backend.applyPulled([tombstone("subject", "p", S2)]);
    expect(backend.notes.groups).toEqual([]);
    expect(backend.notes.pages).toEqual([]);
    expect(backend.links.attachments).toEqual([]);
    for (const k of [
      "note_group:g-1",
      "note_page:pg-1",
      "note_attachment:img-1",
    ]) {
      expect(backend.outbox[k]?.purged, k).toBe(true);
    }
  });

  it("a task tombstone only unlinks the summary written for it", () => {
    const { backend } = makePhone();
    backend.applyPulled([
      subject("p", S1),
      task("t", S1, { subject_id: "p" }),
      notePage("pg-1", "p", S1, { kind: "summary", source_task_id: "t" }),
    ]);
    backend.applyPulled([tombstone("task", "t", S2)]);
    expect(backend.notes.pages[0]).toMatchObject({
      kind: "summary",
      sourceTaskId: null,
    });
    expect(backend.outbox).toEqual({});
  });

  it("a soft-deleted page pulled leaves the notebook, and comes back when restored", async () => {
    const { backend } = makePhone();
    backend.applyPulled([subject("p", S1), notePage("pg-1", "p", S1)]);
    backend.applyPulled([notePage("pg-1", "p", S2, { deleted_at: S2 })]);
    expect((await backend.commands.notebook("p")).ungrouped).toEqual([]);
    backend.applyPulled([notePage("pg-1", "p", "2026-10-04T09:00:09.000Z")]);
    expect((await backend.commands.notebook("p")).ungrouped).toHaveLength(1);
  });
});

describe("apply: shared settings", () => {
  const INBOX_KEY = `setting:${SETTING_INBOX_POSITION}`;

  it("applies a pulled setting, records it in the snapshot and never queues it back", async () => {
    const { backend } = makePhone();
    const r = backend.applyPulled([
      subject("a", S1, { name: "A" }),
      setting(SETTING_INBOX_POSITION, S1, 0.5),
      subject("b", S1, { name: "B" }),
    ]);
    expect(r.applied).toBe(3);
    expect(backend.state.syncedSettings).toEqual({
      [SETTING_INBOX_POSITION]: 0.5,
    });
    expect(backend.snapshot[INBOX_KEY]).toEqual({
      json: JSON.stringify({ value: 0.5 }),
      stamp: S1,
    });
    backend.emitDataChanged(["subjects", "tasks"]);
    expect(backend.outbox).toEqual({});
    // Both projects sit at position 1: « Sans projet » (0.5) comes first.
    expect(await backend.commands.getInboxIndex()).toBe(0);

    // A newer value replaces it.
    backend.applyPulled([setting(SETTING_INBOX_POSITION, S2, 3)]);
    expect(await backend.commands.getInboxIndex()).toBe(2);
    expect(backend.snapshot[INBOX_KEY].stamp).toBe(S2);
    backend.emitDataChanged(["subjects", "tasks"]);
    expect(backend.outbox).toEqual({});
  });

  it("ignores a setting tombstone and an invalid setting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { backend } = makePhone();
      backend.applyPulled([setting(SETTING_INBOX_POSITION, S1, 2)]);
      const r = backend.applyPulled([
        tombstone("setting", SETTING_INBOX_POSITION, S2),
        setting("Bad-Key", S2, 1),
      ]);
      expect(r.applied).toBe(0);
      expect(backend.state.syncedSettings).toEqual({
        [SETTING_INBOX_POSITION]: 2,
      });
      expect(backend.snapshot[INBOX_KEY].stamp).toBe(S1);
      expect(backend.parked).toEqual({});
      backend.applyPulled([setting(SETTING_INBOX_POSITION, S2, "first")]);
      expect(backend.state.syncedSettings[SETTING_INBOX_POSITION]).toBe(2);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps an unknown key as is", () => {
    const { backend } = makePhone();
    backend.applyPulled([setting("theme_x", S1, { dark: true })]);
    expect(backend.state.syncedSettings).toEqual({ theme_x: { dark: true } });
    backend.emitDataChanged(["subjects"]);
    expect(backend.outbox).toEqual({});
  });
  it("shows a pulled shared theme, and sends one chosen here, while the switch is on", async () => {
    const { backend } = makePhone();
    backend.applyPulled([
      setting(SETTING_APPEARANCE, S1, { theme: "dark", color: "cocoa" }),
    ]);
    let s = await backend.commands.getSettings();
    expect([s.theme, s.colorTheme]).toEqual(["dark", "cocoa"]);
    expect(backend.outbox).toEqual({});

    s = await backend.commands.updateSettings(
      settingsPatch({ colorTheme: "lagoon" }),
    );
    expect([s.theme, s.colorTheme]).toEqual(["dark", "lagoon"]);
    expect(Object.keys(backend.outbox)).toEqual([
      `setting:${SETTING_APPEARANCE}`,
    ]);

    // Switched off: this phone keeps its theme, whatever the others choose.
    await backend.commands.updateSettings(settingsPatch({ syncTheme: false }));
    backend.applyPulled([
      setting(SETTING_APPEARANCE, S2, { theme: "light", color: "sage" }),
    ]);
    s = await backend.commands.getSettings();
    expect([s.theme, s.colorTheme, s.syncTheme]).toEqual([
      "dark",
      "lagoon",
      false,
    ]);
  });
});
