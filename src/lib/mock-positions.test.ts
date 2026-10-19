import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./mock-backend";

// Sync (docs/SYNC.md § 6.2): placement like the core's db/positions.rs, so that one
// move on the phone changes one row (whole-row "last writer wins" must not touch siblings).

const at = new Date(2026, 9, 1, 10, 0);

describe("mock positions", () => {
  let backend: MockBackend;
  let c: MockBackend["commands"];

  const task = (title: string, subjectId: string | null = null) =>
    c.createTask({
      title,
      description: null,
      subjectId,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });

  const subject = (id: string) => {
    const s = backend.state.subjects.find((x) => x.id === id);
    if (!s) throw new Error(`no subject ${id}`);
    return s;
  };

  const positions = () =>
    new Map(backend.state.tasks.map((t) => [t.id, t.position]));

  beforeEach(() => {
    backend = new MockBackend({ now: () => at, seed: false });
    c = backend.commands;
  });

  it("moves one task by changing only its own position", async () => {
    const a = await task("A");
    const b = await task("B");
    const d = await task("D");
    const p = await c.createSubject({
      name: "P",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const x = await task("X", p.id);
    const before = positions();
    await c.moveTask({ id: x.id, subjectId: null, sectionId: null, index: 1 });
    const after = positions();
    const changed = [...after].filter(([id, pos]) => before.get(id) !== pos);
    expect(changed.map(([id]) => id)).toEqual([x.id]);
    expect(after.get(x.id)).toBe(1.5);
    // Order A, X, B, D.
    const order = [a.id, x.id, b.id, d.id].map((id) => after.get(id) ?? 0);
    expect([...order].sort((m, n) => m - n)).toEqual(order);
    // First place: first - 1; past the end: max + 1.
    await c.moveTask({ id: d.id, subjectId: null, sectionId: null, index: 0 });
    expect(positions().get(d.id)).toBe(0);
    await c.moveTask({
      id: d.id,
      subjectId: null,
      sectionId: null,
      index: null,
    });
    expect(positions().get(d.id)).toBe(3);
  });

  it("appends projects at max + 1 and breaks position ties by id", async () => {
    const a = await c.createSubject({
      name: "A",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const b = await c.createSubject({
      name: "B",
      color: null,
      rootPath: null,
      parentId: null,
    });
    subject(b.id).position = 5;
    const d = await c.createSubject({
      name: "D",
      color: null,
      rootPath: null,
      parentId: null,
    });
    expect(subject(d.id).position).toBe(6);
    subject(a.id).position = 6;
    const list = await c.listSubjects();
    const tied = list.filter((s) => s.position === 6).map((s) => s.id);
    expect(tied).toEqual([a.id, d.id].sort());
  });
});
