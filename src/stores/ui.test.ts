import { beforeEach, describe, expect, it } from "vitest";
import {
  FOLDED_NOTE_GROUPS_KEY,
  INITIAL_VIEW,
  LAST_NOTE_PAGE_KEY,
  noteFoldKey,
  resetUi,
  useUi,
} from "./ui";

describe("view at launch", () => {
  it("is « À faire », whatever was opened before", () => {
    expect(INITIAL_VIEW).toEqual({ kind: "all", subjectId: null });
    resetUi();
    useUi.getState().setView({ kind: "subject", subjectId: "s1" });
    expect(window.localStorage.getItem("todo.lastView")).toBeNull();
  });
});

describe("inline project creation flags", () => {
  beforeEach(() => resetUi());

  it("opens the new-project line and bumps the request on every call", () => {
    useUi.getState().startNewProject();
    useUi.getState().startNewProject();
    expect(useUi.getState()).toMatchObject({
      newProjectOpen: true,
      newProjectRequest: 2,
    });
    useUi.getState().closeNewProject();
    expect(useUi.getState().newProjectOpen).toBe(false);
  });
});

describe("notebook memory (notes task 5)", () => {
  beforeEach(() => resetUi());

  it("remembers the last page of each project and the folded groups in storage", () => {
    useUi.getState().openNotePage("s1", "p1");
    useUi.getState().openNotePage("s2", "p9", true);
    expect(useUi.getState().lastNotePage).toEqual({ s1: "p1", s2: "p9" });
    expect(useUi.getState().notePageSheet).toBe("p9");
    expect(
      JSON.parse(window.localStorage.getItem(LAST_NOTE_PAGE_KEY) ?? "{}"),
    ).toEqual({ s1: "p1", s2: "p9" });

    useUi.getState().toggleNoteGroup(noteFoldKey("s1", "pinned"));
    useUi.getState().toggleNoteGroup(noteFoldKey("s1", { group: "g1" }));
    expect(
      JSON.parse(window.localStorage.getItem(FOLDED_NOTE_GROUPS_KEY) ?? "[]"),
    ).toEqual(["pinned:s1", "g1"]);
  });

  it("changing view or tab closes the phone's page sheet", () => {
    useUi.getState().openNotePage("s1", "p1", true);
    useUi.getState().setProjectTab("list");
    expect(useUi.getState().notePageSheet).toBeNull();
    useUi.getState().openNotePage("s1", "p1", true);
    useUi.getState().setView({ kind: "today", subjectId: null });
    expect(useUi.getState().notePageSheet).toBeNull();
  });
});
