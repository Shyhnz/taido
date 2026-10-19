import { describe, expect, it } from "vitest";
import type { Board, TaskRow, ViewModel } from "../../bindings";
import { fr } from "../../i18n/fr";
import {
  BUBBLE_GAP,
  BUBBLE_MARGIN,
  boardColumnOf,
  newRun,
  openTaskIds,
  placeBubble,
  reduce,
  resumeRun,
  STEP_COUNT,
  STEPS,
  savedProgress,
  stepNumber,
  type TutorialEvent,
  type TutorialRun,
  talkPhase,
} from "./model";
import { stepTitle } from "./texts";

const play = (run: TutorialRun, ...events: TutorialEvent[]) =>
  events.reduce(reduce, run);

describe("first-launch guide steps", () => {
  it("numbers the nine steps between the two cards", () => {
    expect(STEP_COUNT).toBe(9);
    expect(stepNumber("welcome")).toBeNull();
    expect(stepNumber("project")).toBe(1);
    expect(stepNumber("open")).toBe(3);
    // « Lance Claude et parle-lui »: one step, two phases.
    expect(stepNumber("claude")).toBe(4);
    expect(stepNumber("talk")).toBe(4);
    expect(stepTitle("talk")).toBe(stepTitle("claude"));
    expect(stepNumber("kanban")).toBe(5);
    expect(stepNumber("file")).toBe(6);
    expect(stepNumber("quickAdd")).toBe(7);
    expect(stepNumber("complete")).toBe(8);
    expect(stepNumber("account")).toBe(9);
    expect(stepNumber("done")).toBeNull();
    expect(STEPS).not.toContain("search");
    for (const step of STEPS) expect(stepTitle(step)).not.toBe("");
  });

  it("goes through the whole tour from what the user does", () => {
    let run = newRun();
    run = play(run, { type: "start" });
    expect(run.step).toBe("project");
    run = play(run, { type: "subjectCreated", id: "s1" });
    expect(run).toMatchObject({ step: "task", subjectId: "s1" });
    run = play(run, { type: "taskCreated", id: "t1", subjectId: "s1" });
    expect(run).toMatchObject({ step: "open", taskId: "t1" });
    // Another task opened: not the one of the guide.
    run = play(run, { type: "taskOpened", id: "other" });
    expect(run.step).toBe("open");
    run = play(run, { type: "taskOpened", id: "t1" });
    expect(run.step).toBe("claude");
    // Claude starts in the task.
    run = play(run, { type: "ring", taskId: "t1", ring: "starting" });
    expect(run.step).toBe("talk");
    run = play(
      run,
      { type: "ring", taskId: "t1", ring: "working" },
      { type: "ring", taskId: "t1", ring: "waiting" },
      { type: "ring", taskId: "t1", ring: "working" },
      { type: "ring", taskId: "t1", ring: "done" },
    );
    expect(run).toMatchObject({ step: "talk", ring: "done", sawWaiting: true });
    // Green waits for « Continuer », so the user reads it.
    run = play(run, { type: "next" });
    expect(run.step).toBe("kanban");
    // Another task's card moves: not the guide's.
    run = play(run, { type: "taskMoved", id: "other" });
    expect(run.step).toBe("kanban");
    run = play(run, { type: "taskMoved", id: "t1" });
    expect(run.step).toBe("file");
    run = play(run, { type: "attached", id: "other" });
    expect(run.step).toBe("file");
    run = play(run, { type: "attached", id: "t1" });
    expect(run.step).toBe("quickAdd");
    // The guide's own task does not count as the ⌘N one.
    run = play(run, { type: "taskCreated", id: "t1", subjectId: "s1" });
    expect(run.step).toBe("quickAdd");
    run = play(run, { type: "taskCreated", id: "t2", subjectId: "s1" });
    expect(run.step).toBe("complete");
    run = play(run, { type: "taskCompleted", id: "t2" });
    expect(run.step).toBe("complete");
    run = play(run, { type: "taskCompleted", id: "t1" });
    expect(run.step).toBe("account");
    run = play(run, { type: "next" });
    expect(run.step).toBe("done");
    // The cards only move by their own buttons.
    expect(play(run, { type: "next" }).step).toBe("done");
    expect(play(newRun(), { type: "next" }).step).toBe("welcome");
  });

  it("ignores what does not belong to the current step", () => {
    const run = newRun("project");
    expect(play(run, { type: "taskCreated", id: "t", subjectId: null })).toBe(
      run,
    );
    expect(play(run, { type: "taskMoved", id: "t" })).toBe(run);
    expect(play(run, { type: "attached", id: "t" })).toBe(run);
    expect(play(run, { type: "skipClaude" })).toBe(run);
    expect(play(run, { type: "start" })).toBe(run);
  });

  it("skips a step, or the whole Claude part", () => {
    expect(play(newRun("project"), { type: "next" }).step).toBe("task");
    expect(play(newRun("claude"), { type: "skipClaude" }).step).toBe("kanban");
    expect(play(newRun("talk"), { type: "skipClaude" }).step).toBe("kanban");
    expect(play(newRun("talk"), { type: "next" }).step).toBe("kanban");
    expect(play(newRun("kanban"), { type: "next" }).step).toBe("file");
    expect(play(newRun("file"), { type: "next" }).step).toBe("quickAdd");
    expect(play(newRun("quickAdd"), { type: "next" }).step).toBe("complete");
    expect(play(newRun("account"), { type: "next" }).step).toBe("done");
  });

  it("ends « Passe en Kanban » on the done column and skips « Coche » later", () => {
    let run: TutorialRun = { ...newRun("kanban"), taskId: "t1" };
    run = play(run, { type: "taskCompleted", id: "t1" });
    expect(run).toMatchObject({ step: "file", taskDone: true });
    // Checked is not lost: the task still exists.
    run = play(run, { type: "attached", id: "t1" });
    expect(run.step).toBe("quickAdd");
    run = play(run, { type: "taskCreated", id: "t2", subjectId: null });
    expect(run.step).toBe("account");
    // « Passer cette étape » on ⌘N skips « Coche » too.
    const skipped = play(
      { ...newRun("quickAdd"), taskId: "t1", taskDone: true },
      { type: "next" },
    );
    expect(skipped.step).toBe("account");
    // Reopened (dragged out of the done column): « Coche » is back.
    const reopened = play(
      { ...newRun("quickAdd"), taskId: "t1", taskDone: true },
      { type: "taskReopened", id: "t1" },
      { type: "next" },
    );
    expect(reopened).toMatchObject({ step: "complete", taskDone: false });
    // Another task checked during the kanban does not count.
    expect(
      play(
        { ...newRun("kanban"), taskId: "t1" },
        {
          type: "taskCompleted",
          id: "t9",
        },
      ),
    ).toMatchObject({ step: "kanban", taskDone: false });
  });

  it("takes any task when the earlier steps were skipped", () => {
    let run = play(newRun("open"), { type: "taskOpened", id: "x" });
    expect(run).toMatchObject({ step: "claude", taskId: "x" });
    run = play(newRun("complete"), { type: "taskCompleted", id: "y" });
    expect(run.step).toBe("account");
  });

  it("follows the ring of the guide's task only", () => {
    const run = { ...newRun("claude"), taskId: "t1" };
    expect(
      play(run, { type: "ring", taskId: "other", ring: "working" }).step,
    ).toBe("claude");
    // A plain task (no Claude yet) stays on « Lance Claude ».
    expect(play(run, { type: "ring", taskId: "t1", ring: "human" }).step).toBe(
      "claude",
    );
    // A red dot before « Parle à Claude » is not « Claude asked ».
    const talk = play(
      { ...run, step: "open" },
      { type: "ring", taskId: "t1", ring: "waiting" },
    );
    expect(talk.sawWaiting).toBe(false);
  });

  it("goes back to « Une tâche » when the guide's task is deleted", () => {
    const run = { ...newRun("talk"), taskId: "t1", subjectId: "s1" };
    expect(play(run, { type: "taskLost" })).toMatchObject({
      step: "task",
      taskId: null,
      subjectId: "s1",
    });
    for (const step of ["kanban", "file"] as const) {
      expect(
        play({ ...newRun(step), taskId: "t1" }, { type: "taskLost" }),
      ).toMatchObject({ step: "task", taskId: null });
    }
    const later = { ...newRun("quickAdd"), taskId: "t1", taskDone: true };
    expect(play(later, { type: "taskLost" })).toMatchObject({
      step: "quickAdd",
      taskId: null,
      taskDone: false,
    });
  });

  it("says each colour of « Parle à Claude »", () => {
    expect(talkPhase(null)).toBe("ask");
    expect(talkPhase("starting")).toBe("ask");
    expect(talkPhase("idle")).toBe("ask");
    expect(talkPhase("working")).toBe("working");
    expect(talkPhase("waiting")).toBe("waiting");
    expect(talkPhase("done")).toBe("done");
    expect(talkPhase("crashed")).toBe("error");
  });

  it("keeps the progress across launches, without the ring", () => {
    const run = {
      ...newRun("talk"),
      subjectId: "s1",
      taskId: "t1",
      ring: "working" as const,
      sawWaiting: true,
    };
    const saved = savedProgress(run);
    expect(saved).toEqual({
      status: "in_progress",
      step: "talk",
      subjectId: "s1",
      taskId: "t1",
    });
    expect(resumeRun(saved)).toEqual({
      ...newRun("talk"),
      subjectId: "s1",
      taskId: "t1",
    });
    expect(savedProgress(null)).toEqual({
      status: "done",
      step: null,
      subjectId: null,
      taskId: null,
    });
    expect(resumeRun(savedProgress(null))).toBeNull();
    // A step this version does not know starts over at the welcome card.
    expect(resumeRun({ ...saved, step: "gone" })?.step).toBe("welcome");
    // Steps of the first guide resume at the nearest one.
    expect(resumeRun({ ...saved, step: "search" })?.step).toBe("complete");
    expect(resumeRun({ ...saved, step: "phone" })?.step).toBe("account");
  });

  it("keeps the texts in line with the buttons they name", () => {
    expect(fr.tutorial.task.text).toContain(fr.addTask.row);
    expect(fr.tutorial.claude.ready).toContain(
      fr.terminals.launchAgent("claude"),
    );
  });
});

describe("open tasks of « À faire »", () => {
  const row = (id: string, extra: Partial<TaskRow> = {}): TaskRow =>
    ({
      id,
      subjectId: "s1",
      completedAt: null,
      children: [],
      ...extra,
    }) as TaskRow;

  it("lists open tasks and subtasks with their project", () => {
    const view = {
      groups: [
        {
          tasks: [
            row("a", {
              children: [
                row("a1"),
                row("a2", { completedAt: "2026-10-05T10:00:00Z" }),
              ],
            }),
            row("b", { subjectId: null }),
          ],
        },
      ],
    } as unknown as ViewModel;
    expect([...openTaskIds(view)]).toEqual([
      ["a", "s1"],
      ["a1", "s1"],
      ["b", null],
    ]);
    expect(openTaskIds(undefined).size).toBe(0);
  });
});

describe("placement of the bubble", () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 340, height: 160 };

  it("goes on the first side with room", () => {
    const target = { left: 20, top: 300, width: 200, height: 32 };
    const p = placeBubble(target, size, viewport, ["right", "bottom"]);
    expect(p.side).toBe("right");
    expect(p.left).toBe(220 + BUBBLE_GAP);
    // Centred on the element, the arrow on its middle.
    expect(p.top).toBe(316 - 80);
    expect(p.arrow).toBe(80);
  });

  it("falls back to the next side, then under the element", () => {
    const nearRight = { left: 1100, top: 300, width: 120, height: 30 };
    expect(placeBubble(nearRight, size, viewport, ["right", "left"]).side).toBe(
      "left",
    );
    const everywhere = { left: 0, top: 0, width: 1280, height: 800 };
    const p = placeBubble(everywhere, size, viewport, ["right", "left"]);
    expect(p.side).toBe("bottom");
    // Kept inside the window.
    expect(p.top).toBe(800 - 160 - BUBBLE_MARGIN);
  });

  it("stays inside the window and keeps the arrow off the corners", () => {
    const corner = { left: 4, top: 4, width: 10, height: 10 };
    const p = placeBubble(corner, size, viewport, ["bottom"]);
    expect(p).toMatchObject({ side: "bottom", left: BUBBLE_MARGIN });
    expect(p.top).toBe(14 + BUBBLE_GAP);
    expect(p.arrow).toBeGreaterThanOrEqual(18);
  });
});

describe("column of the guide's task on the kanban", () => {
  const card = (id: string) => ({ id }) as TaskRow;
  const board = {
    subjectId: "s1",
    columns: [
      {
        id: "c0",
        name: "À faire",
        isDone: false,
        cards: [card("a")],
        total: 1,
      },
      {
        id: "c1",
        name: "En cours",
        isDone: false,
        cards: [card("b")],
        total: 1,
      },
      { id: "c3", name: "Terminé", isDone: true, cards: [], total: 4 },
    ],
  } as Board;

  it("finds the card's column, the done one for a checked task out of sight", () => {
    expect(boardColumnOf(board, "a", false)).toBe("c0");
    expect(boardColumnOf(board, "b", false)).toBe("c1");
    expect(boardColumnOf(board, "z", true)).toBe("c3");
    expect(boardColumnOf(board, "z", false)).toBeNull();
  });
});
