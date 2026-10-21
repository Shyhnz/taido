/**
 * UI state of the task lists (never data): which group shows its in-place editor, whether
 * the "new section" field is open, and which row should take the focus next.
 *
 * Other areas drive the lists through the request functions below: the project ⋯ menu
 * calls `requestAddSection`, a freshly created project calls `requestAddTask`.
 */

import { create } from "zustand";
import type { ViewKind } from "../../bindings";
import { todayString } from "../../lib/dates";
import { useUi } from "../../stores/ui";

interface ListState {
  /** Group whose in-place editor is open (see `editorKey`); one at a time, like Todoist. */
  editorGroup: string | null;
  /** Project whose "new section" field is open at the bottom of its view. */
  sectionDraftFor: string | null;
  /** Row to focus as soon as it is rendered (after a completion, a move, a refetch). */
  pendingFocusId: string | null;
  /** « Prochainement » day to scroll to as soon as its group is rendered (after a week change). */
  pendingScrollDay: string | null;

  openEditor: (key: string | null) => void;
  closeSectionDraft: () => void;
  focusRow: (taskId: string | null) => void;
}

export const useList = create<ListState>((set) => ({
  editorGroup: null,
  sectionDraftFor: null,
  pendingFocusId: null,
  pendingScrollDay: null,

  openEditor: (editorGroup) => set({ editorGroup, sectionDraftFor: null }),
  closeSectionDraft: () => set({ sectionDraftFor: null }),
  focusRow: (pendingFocusId) => set({ pendingFocusId }),
}));

// A day waiting to be scrolled to belongs to the week and the list it was asked in: leaving
// « Prochainement », switching to the calendar or moving to another week drops it, so a later
// visit never jumps. A jump changes the week first, then asks for its day (`scrollToDay`).
useUi.subscribe((ui, prev) => {
  if (useList.getState().pendingScrollDay === null) return;
  const leftUpcoming = ui.view !== prev.view && ui.view.kind !== "upcoming";
  const leftList =
    ui.upcomingMode !== prev.upcomingMode && ui.upcomingMode !== "list";
  if (leftUpcoming || leftList || ui.upcomingWeek !== prev.upcomingWeek) {
    useList.setState({ pendingScrollDay: null });
  }
});

/** Identifies a group's editor across views: `today::today_rest`, `subject:<id>:no_section`. */
export function editorKey(
  kind: ViewKind,
  subjectId: string | null,
  groupId: string,
): string {
  return `${kind}:${subjectId ?? ""}:${groupId}`;
}

/** Group of each view whose editor `requestAddTask` opens (see `groupId`). */
export const FIRST_ADD_GROUP: Record<ViewKind, string> = {
  subject: "no_section",
  inbox: "inbox",
  today: "today_rest",
  // « Prochainement » opens today's day (see `requestAddTask`).
  upcoming: "day",
  // « À faire » opens « Sans projet » when it is listed.
  all: "no_project",
  // The portfolio has no task list.
  portfolio: "none",
};

function showProject(subjectId: string): void {
  const ui = useUi.getState();
  if (ui.view.kind !== "subject" || ui.view.subjectId !== subjectId) {
    ui.setView({ kind: "subject", subjectId });
  }
}

/**
 * Opens the "new section" field of a project (« Ajouter une section » lives in
 * the project ⋯ menu). Shows the project first when another view is displayed.
 */
export function requestAddSection(subjectId: string): void {
  showProject(subjectId);
  useList.setState({ sectionDraftFor: subjectId, editorGroup: null });
}

/**
 * Opens the in-place editor of the first group of the current view, or of `subjectId`'s
 * project.
 */
export function requestAddTask(subjectId?: string): void {
  if (subjectId) showProject(subjectId);
  const { kind, subjectId: shown } = useUi.getState().view;
  const group =
    kind === "upcoming" ? `day:${todayString()}` : FIRST_ADD_GROUP[kind];
  useList.setState({
    editorGroup: editorKey(kind, shown, group),
    sectionDraftFor: null,
  });
}

/** Resets the store (tests). */
export function resetList(): void {
  useList.setState({
    editorGroup: null,
    sectionDraftFor: null,
    pendingFocusId: null,
    pendingScrollDay: null,
  });
}
