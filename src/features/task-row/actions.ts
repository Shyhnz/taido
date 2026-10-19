/** Task actions shared by rows, the keyboard and the task panel. */

import { createElement } from "react";
import { create } from "zustand";
import type { Agent, Due, Subject } from "../../bindings";
import { announce } from "../../components/LiveRegion";
import type { MenuItem } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { features } from "../../lib/features";
import { projectPath } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import type { Place } from "../dnd/DndProvider";
import { flushPanelEdits } from "../task-panel/debouncedSave";
import {
  confirmStopSessions,
  launchAgent,
  openTerminal,
} from "../terminals/actions";
import { runningTerminals } from "../terminals/terminalList";
import { useList } from "../views/listStore";
import {
  clampPriority,
  displayPriority,
  PriorityRingSvg,
} from "./PriorityRing";

// --- focus within the list --------------------------------------------------

/** Focusable element of each row (the title button), in display order. */
function rowFocusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-task-list] [data-row-focus]"),
  );
}

/** True when the keyboard focus is inside the row of `id`. */
export function rowHasFocus(id: string): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const row = active.closest<HTMLElement>("[data-task-id]");
  return row?.dataset.taskId === id && row.closest("[data-task-list]") !== null;
}

/** True when the focused row of `id` is a subtask shown under its task. */
function isNestedRow(id: string): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const row = active.closest<HTMLElement>("[data-task-id]");
  return row?.dataset.taskId === id && row.closest("[data-subtasks]") !== null;
}

/**
 * The row after `id` in the list, or the one before when `id` is the last. The subtasks of
 * `id` are skipped: they leave the list with it.
 */
export function neighbourRowId(id: string): string | null {
  const ids = rowFocusables()
    .filter(
      (el) =>
        el.closest(`[data-subtasks="${CSS.escape(id)}"]`) === null ||
        el.dataset.rowFocus === id,
    )
    .map((el) => el.dataset.rowFocus ?? "")
    .filter((x) => x.length > 0);
  const index = ids.indexOf(id);
  if (index === -1) return null;
  return (
    ids.slice(index + 1).find((x) => x !== id) ??
    ids
      .slice(0, index)
      .reverse()
      .find((x) => x !== id) ??
    null
  );
}

/** Selects a row and focuses it as soon as it is rendered. */
export function focusTaskRow(id: string | null): void {
  useUi.getState().selectTask(id);
  useList.getState().focusRow(id);
}

// --- completion -------------------------------------------------------------

/** Time the checked row stays in place, then the time it takes to fold. */
export const COMPLETION_HOLD_MS = 700;
export const COMPLETION_COLLAPSE_MS = 200;

export type CompletionPhase = "checking" | "collapsing";

/** Rows playing the completion animation (ring filled, title struck, then folding). */
export const useCompletion = create<{
  phases: Record<string, CompletionPhase>;
}>(() => ({ phases: {} }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function setPhase(id: string, phase: CompletionPhase | null): void {
  useCompletion.setState((s) => {
    const phases = { ...s.phases };
    if (phase) phases[id] = phase;
    else delete phases[id];
    return { phases };
  });
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Checks or unchecks a task right away. Checking shows « Tâche terminée · Annuler » for 5 s
 * and, when the row had the focus, moves it to the next row (not for a subtask under its
 * task: it stays in place).
 */
export async function setCompleted(
  id: string,
  completed: boolean,
  /** The « session tourne » question was already answered (`completeFromRow`). */
  confirmed = false,
) {
  // Checking closes the task's terminals: a running Claude session asks first.
  if (completed && !confirmed && !(await confirmStopSessions(id, "complete"))) {
    return undefined;
  }
  // Reopening forgets any animation; checking from elsewhere (Space, ⌘Enter) during a
  // pointer animation stops its timers, so the task is not checked twice. The animation's
  // own call has already dropped its timer.
  if (!completed || timers.has(id)) cancelCompletion(id);
  // A checked subtask stays shown, struck, under its task: the focus stays on it.
  const next =
    completed && rowHasFocus(id) && !isNestedRow(id)
      ? neighbourRowId(id)
      : null;
  const result = await run(
    commands.setTaskCompleted({ id, completed }),
    fr.errors.action.completeTask,
  );
  if (result === undefined) return undefined;
  if (completed) {
    if (next) focusTaskRow(next);
    showToast({
      message: fr.toast.completed,
      action: {
        label: fr.toast.undo,
        onAction: () => {
          cancelCompletion(id);
          void run(
            commands.setTaskCompleted({ id, completed: false }),
            fr.errors.action.completeTask,
          ).then((task) => {
            if (task) announce(fr.list.announce.reopened(task.title));
          });
        },
      },
    });
  } else {
    announce(fr.list.announce.reopened(result.title));
  }
  return result;
}

/** Stops a completion animation, or forgets a finished one (second click, undo, reopen). */
export function cancelCompletion(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  if (useCompletion.getState().phases[id]) setPhase(id, null);
}

/** A row left the list: forget its committed completion (the animation is over). */
export function forgetCompletion(id: string): void {
  if (!timers.has(id) && useCompletion.getState().phases[id]) {
    setPhase(id, null);
  }
}

/**
 * Pointer completion from a list row: the ring fills and the title is struck
 * for 700 ms, the row folds in 200 ms, then the task is checked. A second click during the
 * hold cancels. With « réduire les animations », the task is checked at once.
 */
export function completeFromRow(id: string): void {
  if (useCompletion.getState().phases[id] === "checking") {
    cancelCompletion(id);
    return;
  }
  if (useCompletion.getState().phases[id]) return;
  // A running Claude session (of the task or of its subtasks) is asked about before the
  // animation, so the row does not fold while the question is open.
  if (runningTerminals().some((t) => t.kind === "agent")) {
    void confirmStopSessions(id, "complete").then((ok) => {
      if (ok) startCompletion(id);
    });
    return;
  }
  startCompletion(id);
}

function startCompletion(id: string): void {
  if (prefersReducedMotion()) {
    void setCompleted(id, true, true);
    return;
  }
  setPhase(id, "checking");
  timers.set(
    id,
    setTimeout(() => {
      setPhase(id, "collapsing");
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void setCompleted(id, true, true).then((result) => {
            if (result === undefined) {
              setPhase(id, null);
              return;
            }
            // The refetch removes the row, whose unmount forgets the phase
            // (`forgetCompletion`); this is only a safety net.
            setTimeout(() => forgetCompletion(id), 2000);
          });
        }, COMPLETION_COLLAPSE_MS),
      );
    }, COMPLETION_HOLD_MS),
  );
}

// --- other actions ----------------------------------------------------------

/**
 * Deletes a task without confirmation; the toast « Tâche supprimée · Annuler » restores it
 * (soft delete). `_title` is kept for callers (the task panel).
 */
export async function deleteTask(id: string, _title: string) {
  // Pending panel edits go first, so the delete never beats them and « Annuler » brings
  // them back (same as the panel's delete).
  flushPanelEdits();
  if (!(await confirmStopSessions(id, "delete"))) return;
  const next = rowHasFocus(id) ? neighbourRowId(id) : null;
  const done = await run(commands.deleteTask(id), fr.errors.action.deleteTask);
  if (done === undefined) return;
  const ui = useUi.getState();
  if (ui.openTaskId === id) ui.openTask(null);
  if (ui.selectedTaskId === id) ui.selectTask(null);
  if (next) focusTaskRow(next);
  showToast({
    message: fr.toast.deleted,
    action: {
      label: fr.toast.undo,
      onAction: () => {
        void run(commands.restoreTask(id), fr.errors.action.deleteTask);
      },
    },
  });
}

export async function duplicateTask(id: string) {
  const copy = await run(
    commands.duplicateTask(id),
    fr.errors.action.duplicateTask,
  );
  if (copy) {
    showToast({ message: fr.toast.duplicated });
    useUi.getState().openTask(copy.id);
  }
}

/** « Ranger dans… » a project (tasks of « Sans projet »); `label` names it in the toast. */
export async function fileTask(
  task: { id: string; title: string },
  subject: Pick<Subject, "id" | "name">,
  label: string = subject.name,
) {
  const next = rowHasFocus(task.id) ? neighbourRowId(task.id) : null;
  const moved = await run(
    commands.moveTask({
      id: task.id,
      subjectId: subject.id,
      sectionId: null,
      index: null,
    }),
    fr.errors.action.moveTask,
  );
  if (!moved) return;
  if (next) focusTaskRow(next);
  showToast({ message: fr.toast.moved(label) });
}

/** Menu of projects for « Ranger dans… »: a sub-project is named with its parent. */
export function fileMenuItems(
  task: { id: string; title: string },
  subjects: Pick<Subject, "id" | "name" | "parentId">[],
): MenuItem[] {
  return subjects.map((s) => {
    const label = projectPath(s, subjects);
    return {
      label,
      onSelect: () => {
        void fileTask(task, s, label);
      },
    };
  });
}

/**
 * ⌥↑ / ⌥↓: moves a task one step within its group (`index` among `size` open tasks).
 * Keeps the focus on the moved row.
 */
export async function moveTaskBy(
  task: { id: string; title: string },
  place: Place,
  index: number,
  size: number,
  delta: 1 | -1,
) {
  const target = index + delta;
  if (target < 0 || target >= size) return;
  const moved = await run(
    commands.moveTask({
      id: task.id,
      subjectId: place.subjectId,
      sectionId: place.sectionId,
      index: target,
    }),
    fr.errors.action.moveTask,
  );
  if (!moved) return;
  focusTaskRow(task.id);
  announce(
    delta === -1
      ? fr.list.announce.movedUp(task.title)
      : fr.list.announce.movedDown(task.title),
  );
}

/** Sets the priority (1 to 4) of a task. */
export async function setPriority(id: string, priority: number) {
  return run(
    commands.setTaskPriority({ id, priority }),
    fr.errors.action.updateTask,
  );
}

/**
 * « Priorité 1 » (red) … « Priorité 4 » (plain), each with its checkbox look (Todoist's
 * flags): stored 4 down to 1 (`displayPriority`).
 */
export function priorityMenuItems(task: {
  id: string;
  priority: number;
}): MenuItem[] {
  return [4, 3, 2, 1].map((p) => ({
    label: fr.priorityRing.menu(displayPriority(p)),
    icon: createElement(PriorityRingSvg, {
      priority: p,
      completed: false,
      size: 15,
    }),
    hint: fr.panelBis.priorityShort(displayPriority(p)),
    checked: clampPriority(task.priority) === p,
    onSelect: () => {
      if (task.priority !== p) void setPriority(task.id, p);
    },
  }));
}

/** Right-click and ⋯ menu of a task row. */
export function taskMenuItems(
  task: {
    id: string;
    title: string;
    due: Due | null;
    subjectId?: string | null;
    /** Shows the four priorities when given. */
    priority?: number;
    /** A subtask moves with its parent (the core refuses `move_task`): no « Déplacer ». */
    parentId?: string | null;
  },
  agent: Agent = "claude",
): MenuItem[] {
  const ui = useUi.getState();
  const priority = task.priority;
  return [
    { label: fr.row.menuOpen, onSelect: () => ui.openTask(task.id) },
    { separator: true },
    ...(features.terminals
      ? [
          {
            label: fr.row.menuLaunchAgent(agent),
            onSelect: () => void launchAgent(task.id, agent),
          },
          {
            label: fr.row.menuOpenShell,
            onSelect: () => void openTerminal(task.id, "shell"),
          },
          { separator: true } as const,
        ]
      : []),
    ...(task.parentId
      ? []
      : [
          {
            // A task of « Sans projet » is filed; any other one is moved.
            label: task.subjectId === null ? fr.row.menuFile : fr.row.menuMove,
            onSelect: () =>
              ui.openDialog({
                type: "moveTask",
                taskId: task.id,
                file: task.subjectId === null,
              }),
          },
        ]),
    {
      label: fr.row.menuDue,
      onSelect: () =>
        ui.openDialog({ type: "due", taskId: task.id, due: task.due }),
    },
    ...(priority !== undefined
      ? [
          { separator: true } as const,
          ...priorityMenuItems({ id: task.id, priority }),
        ]
      : []),
    { separator: true },
    {
      label: fr.row.menuDelete,
      onSelect: () => {
        void deleteTask(task.id, task.title);
      },
    },
  ];
}
