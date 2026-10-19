/**
 * First-launch guide: the steps, how each one ends, and where
 * the bubble goes. Pure: the driver (`TutorialDriver.tsx`) turns what happens in the app into
 * `TutorialEvent`s, the store keeps the `TutorialRun`, the layer draws it.
 *
 * The steps follow what is on screen (open task, kanban shown…), which only the UI knows; the core
 * keeps the progress across launches (`Settings.tutorial`).
 */

import type { Board, Ring, Tutorial, ViewModel } from "../../bindings";

export const STEPS = [
  "welcome",
  "project",
  "task",
  "open",
  "claude",
  "talk",
  "kanban",
  "file",
  "quickAdd",
  "complete",
  "account",
  "done",
] as const;

export type StepId = (typeof STEPS)[number];

/**
 * Steps of « Étape n sur 9 »: all but the two cards, and « talk », which goes on « Lance
 * Claude et parle-lui » under the same number as « claude ».
 */
const COUNTED: readonly StepId[] = STEPS.slice(1, -1).filter(
  (s) => s !== "talk",
);

export const STEP_COUNT = COUNTED.length;

/** 1-based number of a step in « Étape n sur 9 », `null` for the cards. */
export function stepNumber(step: StepId): number | null {
  const i = COUNTED.indexOf(step === "talk" ? "claude" : step);
  return i < 0 ? null : i + 1;
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === "string" && STEPS.some((s) => s === value);
}

/** Steps of earlier versions, resumed at the nearest one. */
const LEGACY_STEPS: Readonly<Record<string, StepId>> = {
  search: "complete",
  phone: "account",
};

function after(step: StepId): StepId {
  const i = STEPS.indexOf(step);
  return STEPS[Math.min(i + 1, STEPS.length - 1)];
}

export interface TutorialRun {
  step: StepId;
  /** Project the guide works in, once created. */
  subjectId: string | null;
  /** Task Claude is launched in (« Essayer Claude »), once created or opened. */
  taskId: string | null;
  /** Current ring of that task, as last seen. */
  ring: Ring | null;
  /** Claude asked something during « Parle à Claude » (the dot went red). */
  sawWaiting: boolean;
  /**
   * The guide's task is checked (dropped on the done column, say): « Coche » is skipped.
   * Not kept across launches: the task's state is read again.
   */
  taskDone: boolean;
}

export type TutorialEvent =
  /** « C'est parti » on the welcome card. */
  | { type: "start" }
  /** « Passer cette étape », or « Continuer » / « Pas maintenant » where shown. */
  | { type: "next" }
  /** « Passer cette partie » when Claude Code is not ready: on to the kanban. */
  | { type: "skipClaude" }
  | { type: "subjectCreated"; id: string }
  | { type: "taskCreated"; id: string; subjectId: string | null }
  /** A task panel opened (click, Enter, ⌘K). */
  | { type: "taskOpened"; id: string }
  | { type: "ring"; taskId: string; ring: Ring }
  /** The guide's task changed column on its project's kanban (out of the first one). */
  | { type: "taskMoved"; id: string }
  /** The guide's task has at least one attachment. */
  | { type: "attached"; id: string }
  | { type: "taskCompleted"; id: string }
  /** The guide's task is open (again). */
  | { type: "taskReopened"; id: string }
  /** The guide's task no longer exists. */
  | { type: "taskLost" };

/** Rings of a task whose Claude terminal runs (the dot shows). */
const CLAUDE_RUNNING: ReadonlySet<Ring> = new Set<Ring>([
  "starting",
  "working",
  "waiting",
  "done",
  "idle",
  "error",
]);

/** Steps that need the guide's task. */
const NEEDS_TASK: ReadonlySet<StepId> = new Set<StepId>([
  "open",
  "claude",
  "talk",
  "kanban",
  "file",
]);

export function newRun(step: StepId = "welcome"): TutorialRun {
  return {
    step,
    subjectId: null,
    taskId: null,
    ring: null,
    sawWaiting: false,
    taskDone: false,
  };
}

/** A run resumed from the saved progress; `null` when there is nothing to resume. */
export function resumeRun(saved: Tutorial): TutorialRun | null {
  if (saved.status !== "in_progress") return null;
  const step = isStepId(saved.step)
    ? saved.step
    : (LEGACY_STEPS[saved.step ?? ""] ?? "welcome");
  return {
    ...newRun(step),
    subjectId: saved.subjectId,
    taskId: saved.taskId,
  };
}

/** What the core keeps of a run (`null`: the guide is over). */
export function savedProgress(run: TutorialRun | null): Tutorial {
  if (run === null) {
    return { status: "done", step: null, subjectId: null, taskId: null };
  }
  return {
    status: "in_progress",
    step: run.step,
    subjectId: run.subjectId,
    taskId: run.taskId,
  };
}

function go(run: TutorialRun, step: StepId): TutorialRun {
  // A guide task already checked (on the kanban) has nothing left to check.
  const to = step === "complete" && run.taskDone ? "account" : step;
  return {
    ...run,
    step: to,
    sawWaiting: to === "talk" ? run.sawWaiting : false,
  };
}

const isGuideTask = (run: TutorialRun, id: string) =>
  run.taskId === null || run.taskId === id;

export function reduce(run: TutorialRun, event: TutorialEvent): TutorialRun {
  const { step } = run;
  switch (event.type) {
    case "start":
      return step === "welcome" ? go(run, "project") : run;
    case "next":
      return step === "welcome" || step === "done" ? run : go(run, after(step));
    case "skipClaude":
      return step === "claude" || step === "talk" ? go(run, "kanban") : run;
    case "subjectCreated":
      return step === "project"
        ? go({ ...run, subjectId: event.id }, "task")
        : run;
    case "taskCreated":
      if (step === "task") {
        return go(
          {
            ...run,
            taskId: event.id,
            subjectId: run.subjectId ?? event.subjectId,
            ring: null,
            taskDone: false,
          },
          "open",
        );
      }
      return step === "quickAdd" && event.id !== run.taskId
        ? go(run, "complete")
        : run;
    case "taskOpened":
      if (step !== "open") return run;
      if (run.taskId !== null && event.id !== run.taskId) return run;
      return go(
        {
          ...run,
          taskId: event.id,
          taskDone: event.id === run.taskId && run.taskDone,
        },
        "claude",
      );
    case "ring": {
      if (event.taskId !== run.taskId) return run;
      const next = {
        ...run,
        ring: event.ring,
        sawWaiting:
          run.sawWaiting || (step === "talk" && event.ring === "waiting"),
      };
      return step === "claude" && CLAUDE_RUNNING.has(event.ring)
        ? go(next, "talk")
        : next;
    }
    case "taskMoved":
      return step === "kanban" && isGuideTask(run, event.id)
        ? go(run, "file")
        : run;
    case "attached":
      return step === "file" && isGuideTask(run, event.id)
        ? go(run, "quickAdd")
        : run;
    case "taskCompleted": {
      if (!isGuideTask(run, event.id)) return run;
      const done =
        run.taskId === null || run.taskDone ? run : { ...run, taskDone: true };
      // Dropped on the done column: the card left the first one too.
      if (step === "kanban") return go(done, "file");
      return step === "complete" ? go(done, "account") : done;
    }
    case "taskReopened":
      return run.taskId === event.id && run.taskDone
        ? { ...run, taskDone: false }
        : run;
    case "taskLost":
      if (run.taskId === null) return run;
      return NEEDS_TASK.has(step)
        ? go({ ...run, taskId: null, ring: null, taskDone: false }, "task")
        : { ...run, taskId: null, ring: null, taskDone: false };
  }
}

/** What « Parle à Claude » says, from the ring of the guide's task. */
export type TalkPhase = "ask" | "working" | "waiting" | "done" | "error";

export function talkPhase(ring: Ring | null): TalkPhase {
  switch (ring) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "done":
      return "done";
    case "error":
    case "crashed":
      return "error";
    default:
      return "ask";
  }
}

/** Ids of the open tasks of a view, subtasks included. */
export function openTaskIds(
  view: ViewModel | undefined,
): Map<string, string | null> {
  const ids = new Map<string, string | null>();
  for (const group of view?.groups ?? []) {
    for (const row of group.tasks) {
      if (row.completedAt === null) ids.set(row.id, row.subjectId);
      for (const child of row.children) {
        if (child.completedAt === null) ids.set(child.id, child.subjectId);
      }
    }
  }
  return ids;
}

/**
 * Column of a task on its project's kanban: the column holding its card, else the done one
 * for a checked task (that column only shows its last cards); `null` when not found.
 */
export function boardColumnOf(
  board: Board,
  taskId: string,
  completed: boolean,
): string | null {
  for (const column of board.columns) {
    if (column.cards.some((card) => card.id === taskId)) return column.id;
  }
  return completed ? (board.columns.find((c) => c.isDone)?.id ?? null) : null;
}

// ---------------------------------------------------------------------------
// Placement of the bubble
// ---------------------------------------------------------------------------

export type Side = "right" | "bottom" | "left" | "top";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  side: Side;
  /** Position of the arrow along the bubble's edge facing the target (px). */
  arrow: number;
}

export const BUBBLE_GAP = 14;
export const BUBBLE_MARGIN = 12;
/** The arrow keeps this far from the bubble's corners. */
const ARROW_INSET = 18;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Puts a bubble of `size` next to `target`, on the first of `sides` where it fits inside the
 * window, else under it; always kept inside the window.
 */
export function placeBubble(
  target: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  sides: readonly Side[],
): Placement {
  const { width: w, height: h } = size;
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  const centerX = target.left + target.width / 2;
  const centerY = target.top + target.height / 2;
  const maxLeft = Math.max(BUBBLE_MARGIN, viewport.width - w - BUBBLE_MARGIN);
  const maxTop = Math.max(BUBBLE_MARGIN, viewport.height - h - BUBBLE_MARGIN);

  const fits: Record<Side, boolean> = {
    right: right + BUBBLE_GAP + w <= viewport.width - BUBBLE_MARGIN,
    left: target.left - BUBBLE_GAP - w >= BUBBLE_MARGIN,
    bottom: bottom + BUBBLE_GAP + h <= viewport.height - BUBBLE_MARGIN,
    top: target.top - BUBBLE_GAP - h >= BUBBLE_MARGIN,
  };
  const side = sides.find((s) => fits[s]) ?? "bottom";

  if (side === "right" || side === "left") {
    const top = clamp(centerY - h / 2, BUBBLE_MARGIN, maxTop);
    const left =
      side === "right" ? right + BUBBLE_GAP : target.left - BUBBLE_GAP - w;
    return {
      side,
      left: clamp(left, BUBBLE_MARGIN, maxLeft),
      top,
      arrow: clamp(centerY - top, ARROW_INSET, h - ARROW_INSET),
    };
  }
  const left = clamp(centerX - w / 2, BUBBLE_MARGIN, maxLeft);
  const top =
    side === "bottom" ? bottom + BUBBLE_GAP : target.top - BUBBLE_GAP - h;
  return {
    side,
    left,
    top: clamp(top, BUBBLE_MARGIN, maxTop),
    arrow: clamp(centerX - left, ARROW_INSET, w - ARROW_INSET),
  };
}
