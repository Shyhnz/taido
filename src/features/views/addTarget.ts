import type { AddTarget } from "../../bindings";
import { type ActiveView, useUi } from "../../stores/ui";

/**
 * Default destination of « Nouvelle tâche » for a view: the
 * project on screen; from Today, « Sans projet » due today; from « Sans projet », no project.
 */
export function addTargetForView(view: ActiveView): AddTarget {
  switch (view.kind) {
    // From « Prochainement » too, a new task is due today (Todoist).
    case "today":
    case "upcoming":
      return { subjectId: null, sectionId: null, dueToday: true };
    case "subject":
      return { subjectId: view.subjectId, sectionId: null, dueToday: false };
    default:
      return { subjectId: null, sectionId: null, dueToday: false };
  }
}

/** Opens the add-task dialog for the current view (sidebar button, ⌘N, `q`). */
export function openAddTaskForView(): void {
  const ui = useUi.getState();
  ui.openDialog({ type: "addTask", target: addTargetForView(ui.view) });
}
