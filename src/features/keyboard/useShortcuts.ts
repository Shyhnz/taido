/**
 * Global keyboard shortcuts: ⌘N, ⌘⇧N, ⌘1 to ⌘3, ⌘K, ⌘,, ⌘Enter, ⌘T, ⌘⇧T, ⌘⇧[, ⌘⇧],
 * ⌘⇧F, Escape, and in the list ↑/↓ or j/k, Enter and `q`. Dialogs and menus handle their own keys first.
 *
 * In a terminal, keys belong to the terminal (Escape interrupts Claude): only the ⌘
 * shortcuts that xterm hands back reach this handler, and ⌘Enter is left alone.
 *
 * Rule: ⌘ shortcuts also work when a text field has the focus (bug #10), but only
 * the keys listed here are taken, so ⌘C, ⌘V, ⌘A, ⌘X and ⌘Z keep working in fields. Shortcuts
 * without ⌘ only work when the focus is in the task list (bug #9).
 */

import { useEffect } from "react";
import { isPromiseDialogOpen } from "../../components/Dialog";
import { isMenuOpen } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { features } from "../../lib/features";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { type ActiveView, useUi } from "../../stores/ui";
import { setCompleted } from "../task-row/actions";
import { cycleTerminal, launchAgent, openTerminal } from "../terminals/actions";
import { openAddTaskForView } from "../views/addTarget";

/**
 * ⌘ + digit → view, in the sidebar's order: ⌘1 « À faire », ⌘2 Aujourd'hui,
 * ⌘3 Prochainement.
 */
const VIEW_SHORTCUTS: Record<string, ActiveView> = {
  Digit1: { kind: "all", subjectId: null },
  Digit2: { kind: "today", subjectId: null },
  Digit3: { kind: "upcoming", subjectId: null },
};

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** ⌘ on macOS, Ctrl elsewhere. On macOS Ctrl stays free for text fields. */
function isMod(e: KeyboardEvent): boolean {
  return e.metaKey || (!IS_MAC && e.ctrlKey);
}

/**
 * Physical digit of the key. On an AZERTY keyboard ⌘1 gives `key === "&"`; `code` stays
 * "Digit1" whatever the layout.
 */
function digitCode(e: KeyboardEvent): string | null {
  if (/^Digit\d$/.test(e.code)) return e.code;
  if (/^\d$/.test(e.key)) return `Digit${e.key}`;
  return null;
}

/**
 * Bug B1: after a click, the clicked sidebar item keeps the focus; a keyboard shortcut then
 * makes it match `:focus-visible`, so its focus ring stayed on the previous item while another
 * one became active. Navigating by shortcut releases that focus.
 */
function releaseNavFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest("[data-nav-item]")) el.blur();
}

function isEditable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return type !== "checkbox" && type !== "radio" && type !== "button";
  }
  return false;
}

/** True when the event comes from a terminal (xterm's hidden textarea). */
function inTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".xterm") !== null;
}

function inForm(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("form") !== null;
}

function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "BUTTON" ||
      target.tagName === "A" ||
      target.getAttribute("role") === "button" ||
      target.getAttribute("role") === "separator")
  );
}

/**
 * True when the shortcuts without ⌘ apply: the focus is in the task list, or nowhere (just
 * after launch, or after a click on an empty area).
 */
function listHasFocus(listFocused: boolean): boolean {
  const active = document.activeElement;
  return listFocused || active === null || active === document.body;
}

function scrollToTask(id: string) {
  const el = document.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
  if (el && "scrollIntoView" in el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest" });
  }
}

/** Tasks whose ⌘Enter is in flight: a second press waits for the first one. */
const toggling = new Set<string>();

/**
 * ⌘Enter: checks an open task, reopens a completed one (bug #6). The state comes from the
 * core (`completedAt`), not from the list, which may not show the task (panel open on a
 * completed task while « Terminées » is folded).
 */
export async function toggleTaskCompleted(id: string): Promise<void> {
  if (toggling.has(id)) return;
  toggling.add(id);
  try {
    const task = await run(commands.getTask(id), fr.errors.action.completeTask);
    if (!task) return;
    if (task.completedAt === null) {
      await setCompleted(id, true);
      return;
    }
    const reopened = await run(
      commands.setTaskCompleted({ id, completed: false }),
      fr.errors.action.completeTask,
    );
    if (reopened) showToast({ message: fr.app.reopened });
  } finally {
    toggling.delete(id);
  }
}

/** Task targeted by ⌘Enter: the selected row, else the task open in the panel. */
function targetTaskId(): string | null {
  const ui = useUi.getState();
  const selected = ui.visibleTasks.some((t) => t.id === ui.selectedTaskId)
    ? ui.selectedTaskId
    : null;
  return selected ?? ui.openTaskId;
}

/**
 * -1 for the `[` key, 1 for `]`, 0 otherwise. The physical key first (`code`), since Shift
 * turns `key` into `{` / `}` on a US layout; `key` as a fallback.
 */
function bracketStep(e: KeyboardEvent): -1 | 0 | 1 {
  if (e.code === "BracketLeft" || e.key === "[" || e.key === "{") return -1;
  if (e.code === "BracketRight" || e.key === "]" || e.key === "}") return 1;
  return 0;
}

/** ⌘ shortcuts. Returns true when the event was handled. */
function handleModShortcut(e: KeyboardEvent, inField: boolean): boolean {
  const ui = useUi.getState();
  const key = e.key.toLowerCase();

  if (!e.shiftKey) {
    const digit = digitCode(e);
    const view = digit ? VIEW_SHORTCUTS[digit] : undefined;
    if (view) {
      releaseNavFocus();
      ui.setView(view);
      return true;
    }
  }
  if (key === "n") {
    if (e.shiftKey) ui.startNewProject();
    else openAddTaskForView();
    return true;
  }
  // ⌘, « Réglages ».
  if (e.key === "," && !e.shiftKey) {
    ui.openDialog({ type: "settings" });
    return true;
  }
  // ⌘K « Aller à une tâche ».
  if (key === "k" && !e.shiftKey && features.search) {
    ui.openDialog({ type: "search" });
    return true;
  }
  // ⌘T: the default agent in the open task.
  if (key === "t" && !e.shiftKey) {
    if (!ui.openTaskId) return false;
    void launchAgent(ui.openTaskId);
    return true;
  }
  // ⌘⇧T: a shell in the open task.
  if (key === "t" && e.shiftKey) {
    if (!ui.openTaskId) return false;
    void openTerminal(ui.openTaskId, "shell");
    return true;
  }
  // ⌘⇧[ and ⌘⇧]: previous or next terminal of the open task.
  const step = bracketStep(e);
  if (step !== 0 && e.shiftKey) {
    if (!ui.openTaskId) return false;
    void cycleTerminal(ui.openTaskId, step);
    return true;
  }
  // ⌘⇧F: focus mode, the task panel takes the window.
  if (key === "f" && e.shiftKey) {
    if (!ui.openTaskId) return false;
    ui.setFocusMode(!ui.focusMode);
    return true;
  }
  // ⌘Enter checks the task, from a field too. Fields that submit on Enter
  // prevent the event first, and a form field keeps it for its form.
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !(inField && inForm(e.target)) &&
    !inTerminal(e.target)
  ) {
    const id = targetTaskId();
    if (!id) return false;
    void toggleTaskCompleted(id);
    return true;
  }
  return false;
}

export function handleShortcut(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const ui = useUi.getState();
  if (ui.dialog || isPromiseDialogOpen() || isMenuOpen()) return;
  const inField = isEditable(e.target);

  if (isMod(e) && !e.altKey) {
    if (handleModShortcut(e, inField)) e.preventDefault();
    return;
  }
  if (inTerminal(e.target)) return;

  if (inField) {
    // In a field, Escape just leaves it.
    if (e.key === "Escape") {
      e.preventDefault();
      e.target.blur();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "Escape") {
    if (ui.focusMode) {
      // Leaves focus mode first; the next Escape closes the panel.
      e.preventDefault();
      ui.setFocusMode(false);
    } else if (ui.openTaskId) {
      e.preventDefault();
      ui.openTask(null);
    } else if (ui.selectedTaskId) {
      ui.selectTask(null);
    }
    return;
  }

  // Shortcuts without ⌘: only in the list (bug #9).
  if (!listHasFocus(ui.listFocused)) return;

  switch (e.key) {
    case "ArrowDown":
    case "j":
      e.preventDefault();
      ui.moveSelection(1);
      break;
    case "ArrowUp":
    case "k":
      e.preventDefault();
      ui.moveSelection(-1);
      break;
    case "Enter":
      if (isActivatable(e.target) || !ui.selectedTaskId) return;
      e.preventDefault();
      ui.openTask(ui.selectedTaskId);
      return;
    case "q":
      e.preventDefault();
      openAddTaskForView();
      return;
    // Shows or folds the sidebar, like Todoist's « M ».
    case "m":
      e.preventDefault();
      ui.toggleSidebar();
      return;
    default:
      return;
  }
  const selected = useUi.getState().selectedTaskId;
  if (selected) scrollToTask(selected);
}

export function useShortcuts(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);
}
