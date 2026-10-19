/**
 * Project actions: inline creation and rename, Couleur, Ajouter une section,
 * Supprimer (explicit confirmation, then a toast « Annuler » that restores it). Folder entries
 * only exist once terminals ship. « Ajouter un
 * sous-projet » and « Déplacer vers… » (one level of sub-projects, like Todoist).
 */

import { create } from "zustand";
import type { Subject, SubjectColor } from "../../bindings";
import { confirmDialog } from "../../components/Dialog";
import { announce } from "../../components/LiveRegion";
import { type MenuItem, useMenuStore } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { features } from "../../lib/features";
import { SUBJECT_COLORS } from "../../lib/format";
import { commands, openFolder } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { requestAddSection, requestAddTask } from "../views/listStore";
import { ColorSwatch } from "./ColorSwatch";
import { projectGroupItems } from "./groupActions";

/**
 * Project whose sidebar row takes the focus back once the list is re-rendered (⌥↑ / ⌥↓ moved
 * it). The row clears it when it focuses itself.
 */
export const useProjectFocus = create<{ focusId: string | null }>(() => ({
  focusId: null,
}));

/**
 * ⌥↑ / ⌥↓ on a sidebar project: one step within its level, focus kept, move announced. At
 * the top level the index counts « Sans projet »; while the sidebar hides it, its slot
 * (`hiddenIndex`) is skipped so every keystroke visibly moves the project.
 */
export async function moveSubjectBy(
  subject: Pick<Subject, "id" | "name">,
  index: number,
  count: number,
  delta: 1 | -1,
  hiddenIndex: number | null = null,
) {
  let target = index + delta;
  if (target === hiddenIndex) target += delta;
  if (target < 0 || target >= count) return;
  const done = await run(
    commands.reorderSubject({ id: subject.id, index: target }),
    t.errors.action.reorder,
  );
  if (done === undefined) return;
  useProjectFocus.setState({ focusId: subject.id });
  announce(
    delta === -1
      ? t.sidebar.announce.movedUp(subject.name)
      : t.sidebar.announce.movedDown(subject.name),
  );
}

/** Focus key of the sidebar « Sans projet » row in `useProjectFocus` (never a project id). */
export const INBOX_FOCUS_ID = "inbox";

/** ⌥↑ / ⌥↓ on the sidebar « Sans projet » row: one step among the top-level projects. */
export async function moveInboxBy(index: number, count: number, delta: 1 | -1) {
  const target = index + delta;
  if (target < 0 || target >= count) return;
  const done = await run(
    commands.reorderInbox(target),
    t.errors.action.reorder,
  );
  if (done === undefined) return;
  useProjectFocus.setState({ focusId: INBOX_FOCUS_ID });
  announce(
    delta === -1
      ? t.sidebar.announce.inboxMovedUp
      : t.sidebar.announce.inboxMovedDown,
  );
}

/** Sidebar-only editing state: the project whose name is being edited in place. */
export const useProjectRename = create<{
  renamingId: string | null;
  start: (id: string) => void;
  stop: () => void;
}>((set) => ({
  renamingId: null,
  start: (renamingId) => set({ renamingId }),
  stop: () => set({ renamingId: null }),
}));

const patch = (id: string) => ({
  id,
  name: null,
  color: null,
  rootPath: null,
  parentId: null,
});

/** Sub-projects of `subject` among `subjects` (the flat `list_subjects`). */
export function subProjectsOf(
  subject: Pick<Subject, "id">,
  subjects: Subject[],
): Subject[] {
  return subjects.filter((s) => s.parentId === subject.id);
}

/** Folder a project works in: its own, else its parent's for a sub-project. */
export function effectiveFolder(
  subject: Subject,
  subjects: Subject[],
): string | null {
  if (subject.rootPath || !subject.parentId) return subject.rootPath;
  return subjects.find((s) => s.id === subject.parentId)?.rootPath ?? null;
}

/**
 * Parents `subject` may move under, one level only: the other top-level
 * projects, none when it has sub-projects itself.
 */
export function parentChoices(
  subject: Subject,
  subjects: Subject[],
): Subject[] {
  if (subProjectsOf(subject, subjects).length > 0) return [];
  return subjects.filter((s) => s.parentId === null && s.id !== subject.id);
}

/**
 * Color of a new project: the first palette color no project uses yet, else the one after
 * the last project's color. Chosen by the UI so the inline line can preview it.
 */
export function nextProjectColor(subjects: Subject[]): SubjectColor {
  const used = new Set(subjects.map((s) => s.color));
  const free = SUBJECT_COLORS.find((c) => !used.has(c));
  if (free) return free;
  const last = subjects[subjects.length - 1];
  const index = last ? SUBJECT_COLORS.indexOf(last.color) : -1;
  return SUBJECT_COLORS[(index + 1) % SUBJECT_COLORS.length];
}

/**
 * Creates a project with no folder (D5), under `parentId` for a sub-project.
 * With `open`, shows it and asks the project view to put the cursor in its add-task line.
 * Resolves to `undefined` on failure (toast shown).
 */
export async function createProject(
  name: string,
  color: SubjectColor,
  open: boolean,
  parentId: string | null = null,
): Promise<Subject | undefined> {
  const subject = await run(
    commands.createSubject({
      name: name.trim(),
      color,
      rootPath: null,
      parentId,
    }),
    t.errors.action.createSubject,
  );
  // Shows the project with the cursor in its add-task line.
  if (subject && open) requestAddTask(subject.id);
  return subject;
}

/** Saves an in-place rename; empty or unchanged names are ignored. */
export async function saveSubjectName(subject: Subject, name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed === subject.name) return;
  await run(
    commands.updateSubject({ ...patch(subject.id), name: trimmed }),
    t.errors.action.updateSubject,
  );
}

export async function changeSubjectFolder(subject: Subject) {
  // A sub-project without folder uses its parent's.
  const title = subject.parentId
    ? t.subProjects.pickFolderTitle
    : t.subject.pickFolderTitle;
  const path = await run(commands.pickFolder(title));
  if (!path) return;
  await run(
    commands.updateSubject({ ...patch(subject.id), rootPath: path }),
    t.errors.action.updateSubject,
  );
}

/**
 * Restores a deleted project (with its sub-projects) and, when `reopenId` is set, reopens that
 * view: the project that was on screen, which may be one of the restored sub-projects.
 */
async function restoreSubject(id: string, reopenId: string | null) {
  const restored = await run(
    commands.restoreSubject(id),
    t.projectNav.restoreError,
  );
  if (restored && reopenId !== null) {
    useUi.getState().setView({ kind: "subject", subjectId: reopenId });
  }
}

/**
 * Explicit confirmation stating the task count, soft delete, then « Annuler ». A
 * parent takes its sub-projects with it, and the message says so.
 */
export async function deleteSubject(
  subject: Subject,
  subProjects: Subject[] = [],
) {
  const message = t.subject.deleteMessage(subject.openCount);
  const ok = await confirmDialog({
    title: t.subject.deleteTitle(subject.name),
    message:
      subProjects.length > 0
        ? `${message} ${t.subProjects.deleteChildren(subProjects.length)}`
        : message,
    confirmLabel: t.subject.deleteConfirm,
  });
  if (!ok) return;
  const done = await run(
    commands.deleteSubject(subject.id),
    t.errors.action.deleteSubject,
  );
  if (done === undefined) return;
  const ui = useUi.getState();
  const gone = new Set([subject.id, ...subProjects.map((s) => s.id)]);
  // The project on screen when it is among the deleted ones (the parent or a sub-project).
  const openId =
    ui.view.kind === "subject" &&
    ui.view.subjectId !== null &&
    gone.has(ui.view.subjectId)
      ? ui.view.subjectId
      : null;
  if (openId !== null) ui.setView({ kind: "today", subjectId: null });
  showToast({
    message: t.toast.subjectDeleted(subject.name),
    action: {
      label: t.toast.undo,
      onAction: () => {
        void restoreSubject(subject.id, openId);
      },
    },
  });
}

function colorItems(subject: Subject): MenuItem[] {
  return SUBJECT_COLORS.map((color) => ({
    label: t.subject.colors[color],
    icon: <ColorSwatch color={color} />,
    checked: subject.color === color ? true : undefined,
    onSelect: () => {
      void run(
        commands.updateSubject({ ...patch(subject.id), color }),
        t.errors.action.updateSubject,
      );
    },
  }));
}

/** The project ⋯ menu. `subjects` is the whole flat list (sub-projects, parents, folders). */
export function subjectMenuItems(
  subject: Subject,
  position: { x: number; y: number },
  subjects: Subject[] = [],
): MenuItem[] {
  const subProjects = subProjectsOf(subject, subjects);
  const folder = effectiveFolder(subject, subjects);
  return [
    {
      label: t.subject.menuRename,
      onSelect: () => {
        // After the menu has closed and given the focus back, so the input keeps it.
        setTimeout(() => useProjectRename.getState().start(subject.id), 0);
      },
    },
    {
      label: t.subject.menuColor,
      hint: "›",
      onSelect: () => {
        // Opened right after the parent menu closes.
        setTimeout(() => {
          useMenuStore
            .getState()
            .open(
              position.x,
              position.y,
              colorItems(subject),
              t.subject.menuColor,
            );
        }, 0);
      },
    },
    {
      label: t.subject.menuAddSection,
      // Opens the view's in-place « Nouvelle section » field.
      onSelect: () => requestAddSection(subject.id),
    },
    // Taido V2.2 bis: groups (visual only) replace the sub-projects.
    ...projectGroupItems([subject.id], subjects, position),
    // The on-disk folder only matters once terminals exist, and never on
    // the phone.
    ...(features.terminals && features.folders
      ? [
          {
            label: t.subject.menuLinkFolder,
            onSelect: () => {
              void changeSubjectFolder(subject);
            },
          },
          ...(folder
            ? [
                {
                  label: t.subject.menuOpenFolder,
                  onSelect: () => {
                    void run(openFolder(folder), t.app.openFolderError);
                  },
                },
              ]
            : []),
        ]
      : []),
    { separator: true },
    {
      label: t.subject.menuDelete,
      danger: true,
      onSelect: () => {
        void deleteSubject(subject, subProjects);
      },
    },
  ];
}
