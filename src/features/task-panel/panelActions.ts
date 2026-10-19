/** Actions of the task panel: deferred text saves, delete with undo, focus back to the row. */

import { showError, showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { commands, errorMessage, isNotFound } from "../../lib/ipc";
import { readableError, run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { confirmStopSessions } from "../terminals/actions";
import { flushPanelEdits } from "./debouncedSave";

/**
 * Saves the title or the note. A task deleted meanwhile is not an error worth a toast (the
 * flush on close may run after a delete from elsewhere).
 */
export async function saveTaskText(
  id: string,
  patch: { title?: string; description?: string },
): Promise<void> {
  try {
    await commands.updateTask({
      id,
      title: patch.title ?? null,
      description: patch.description ?? null,
    });
  } catch (error) {
    console.error(errorMessage(error), error);
    if (!isNotFound(error)) {
      showError(readableError(error, t.errors.action.updateTask));
    }
  }
}

/** Deletes at once (soft delete) and offers « Annuler » for 5 s (`restore_task`). */
export async function deleteTaskWithUndo(id: string): Promise<void> {
  // Pending title or note edits are saved first, so undo brings them back too.
  flushPanelEdits();
  if (!(await confirmStopSessions(id, "delete"))) return;
  const done = await run(commands.deleteTask(id), t.errors.action.deleteTask);
  if (done === undefined) return;
  const ui = useUi.getState();
  if (ui.openTaskId === id) ui.openTask(null);
  if (ui.selectedTaskId === id) ui.selectTask(null);
  showToast({
    message: t.toast.deleted,
    action: {
      label: t.toast.undo,
      onAction: () => {
        void run(commands.restoreTask(id), t.errors.action.deleteTask).then(
          (task) => {
            if (task) useUi.getState().openTask(task.id);
          },
        );
      },
    },
  });
}

/**
 * Puts the focus back on the task's row in the list, when it is shown: the row
 * itself if focusable, else its title button (`data-row-focus`, the row's tab stop).
 * Returns false when the row is not in the list.
 */
export function focusTaskRow(id: string): boolean {
  const row = document.querySelector<HTMLElement>(
    `[data-task-id="${CSS.escape(id)}"]`,
  );
  if (!row) return false;
  const target =
    row.tabIndex >= 0
      ? row
      : (row.querySelector<HTMLElement>("[data-row-focus]") ??
        row.querySelector<HTMLElement>("[data-task-open]") ??
        Array.from(row.querySelectorAll<HTMLElement>("button")).find(
          (b) => !b.hasAttribute("aria-label"),
        ) ??
        null);
  if (!target) return false;
  target.focus();
  return true;
}
