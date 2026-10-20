import { describe, expect, it } from "vitest";
import type { AddTarget, Subject } from "../../bindings";
import {
  addedInView,
  destinationItems,
  destinationLabel,
  draftFromTarget,
  dueChoiceOf,
  dueDateOf,
  dueTimeOf,
} from "./TaskEditor";

const today: AddTarget = { subjectId: null, sectionId: null, dueToday: true };
const project: AddTarget = { subjectId: "p", sectionId: null, dueToday: false };

describe("TaskEditor draft", () => {
  it("resolves the due date when the task is added, not when the editor opens", () => {
    const draft = draftFromTarget(today);
    expect(draft.due).toBe("today");
    // An editor opened on 1 October and used after midnight.
    expect(dueDateOf(draft.due, new Date(2026, 9, 2, 0, 5))).toBe("2026-10-02");
    expect(dueDateOf("tomorrow", new Date(2026, 9, 2, 0, 5))).toBe(
      "2026-10-03",
    );
    expect(dueDateOf(null)).toBeNull();
  });

  it("knows when the new task stays in the list on screen", () => {
    const base = draftFromTarget(today);
    expect(addedInView(today, base)).toBe(true);
    expect(addedInView(today, { ...base, subjectId: "p" })).toBe(true);
    expect(addedInView(today, { ...base, due: "tomorrow" })).toBe(false);
    expect(addedInView(today, { ...base, due: null })).toBe(false);
    const inProject = draftFromTarget(project);
    expect(addedInView(project, { ...inProject, due: "today" })).toBe(true);
    expect(addedInView(project, { ...inProject, subjectId: null })).toBe(false);
  });

  it("keeps a date picked in the calendar, relative only for today and tomorrow", () => {
    const now = new Date(2026, 9, 3, 10, 0);
    expect(dueChoiceOf({ date: "2026-10-03", time: null }, now)).toBe("today");
    expect(dueChoiceOf({ date: "2026-10-04", time: null }, now)).toBe(
      "tomorrow",
    );
    expect(dueChoiceOf({ date: null, time: null }, now)).toBeNull();
    const picked = dueChoiceOf({ date: "2027-10-20", time: "9:30" }, now);
    expect(dueDateOf(picked, now)).toBe("2027-10-20");
    expect(dueTimeOf(picked)).toBe("9:30");
    expect(addedInView(today, { ...draftFromTarget(today), due: picked })).toBe(
      false,
    );
  });
});

const sub = (
  id: string,
  name: string,
  parentId: string | null,
  sections: string[] = [],
): Subject => ({
  id,
  name,
  color: "teal",
  rootPath: null,
  position: null,
  sections: sections.map((s, i) => ({
    id: `${id}-${i}`,
    subjectId: id,
    name: s,
    subpath: null,
    position: i,
    openCount: 0,
  })),
  openCount: 0,
  dot: null,
  parentId,
  isGroup: false,
});

describe("destination picker with sub-projects", () => {
  const TREE = [
    sub("globex", "Globex", null),
    sub("globex-admin", "Admin", "globex", ["Factures"]),
    sub("perso", "Perso", null),
    sub("perso-admin", "Admin", "perso"),
  ];

  it("names a sub-project and its sections with the parent", () => {
    const draft = draftFromTarget(today);
    const labels = destinationItems(draft, TREE, () => {}).map((i) =>
      "label" in i ? i.label : null,
    );
    expect(labels).toEqual([
      "Sans projet",
      "Globex",
      "Globex › Admin",
      "Globex › Admin › Factures",
      "Perso",
      "Perso › Admin",
    ]);
    expect(destinationLabel({ ...draft, subjectId: "perso-admin" }, TREE)).toBe(
      "Perso › Admin",
    );
    expect(
      destinationLabel(
        { ...draft, subjectId: "globex-admin", sectionId: "globex-admin-0" },
        TREE,
      ),
    ).toBe("Globex › Admin › Factures");
  });
});
