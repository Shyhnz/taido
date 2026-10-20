/**
 * Groups of projects in the mock backend, like the core's
 * `subjects::group_projects`: visual only, no task inside, emptied groups disappear.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./mock-backend";

let b: MockBackend;

const project = async (name: string) =>
  (
    await b.commands.createSubject({
      name,
      color: null,
      rootPath: null,
      parentId: null,
    })
  ).id;

const sidebar = async () => {
  const all = await b.commands.listSubjects();
  return all.map((s) => {
    const group = all.find((g) => g.id === s.parentId);
    return `${group ? `${group.name} › ` : ""}${s.name}${s.isGroup ? " (groupe)" : ""}`;
  });
};

beforeEach(() => {
  b = new MockBackend({ seed: false });
});

describe("groups (mock core)", () => {
  it("groups projects in place, ungroups them after the group, dissolves it", async () => {
    await project("Acme Studio");
    const peak = await project("SummitEvents");
    const admin = await project("Admin");
    await project("Perso");
    const globex = await b.commands.groupProjects({
      projectIds: [peak, admin],
      groupId: null,
      name: "Globex",
    });
    expect(await sidebar()).toEqual([
      "Acme Studio",
      "Globex (groupe)",
      "Globex › SummitEvents",
      "Globex › Admin",
      "Perso",
    ]);
    await b.commands.ungroupProjects([peak]);
    expect(await sidebar()).toEqual([
      "Acme Studio",
      "Globex (groupe)",
      "Globex › Admin",
      "SummitEvents",
      "Perso",
    ]);
    await b.commands.dissolveGroup(globex);
    expect(await sidebar()).toEqual([
      "Acme Studio",
      "Admin",
      "SummitEvents",
      "Perso",
    ]);
  });

  it("names a new group « Nouveau groupe » and drops a group left empty", async () => {
    const a = await project("A");
    const c = await project("C");
    const first = await b.commands.groupProjects({
      projectIds: [a],
      groupId: null,
      name: null,
    });
    const second = await b.commands.groupProjects({
      projectIds: [c],
      groupId: null,
      name: "Deux",
    });
    expect((await b.commands.listSubjects())[0].name).toBe("Nouveau groupe");
    await b.commands.groupProjects({
      projectIds: [a],
      groupId: second,
      name: null,
    });
    const ids = (await b.commands.listSubjects()).map((s) => s.id);
    expect(ids).not.toContain(first);
  });

  it("refuses tasks, sections and groups inside a group", async () => {
    const a = await project("A");
    const g = await b.commands.groupProjects({
      projectIds: [a],
      groupId: null,
      name: "G",
    });
    await expect(
      b.commands.createTask({
        title: "T",
        description: null,
        subjectId: g,
        sectionId: null,
        dueDate: null,
        dueTime: null,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      b.commands.createSection({ subjectId: g, name: "S", subpath: null }),
    ).rejects.toMatchObject({ kind: "invalid" });
    const other = await project("B");
    await expect(
      b.commands.groupProjects({ projectIds: [other], groupId: a, name: null }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});
