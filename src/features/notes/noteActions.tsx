/**
 * Actions of the notebook: new page and group, the page
 * menu (Épingler, Déplacer vers, Dupliquer, Supprimer + « Annuler ») and the group menu
 * (Renommer, Supprimer). The core decides order, pins and groups; these only send commands.
 */

import { create } from "zustand";
import type { NoteGroup, NoteKind } from "../../bindings";
import { confirmDialog, promptDialog } from "../../components/Dialog";
import { type MenuItem, useMenuStore } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { t as strings } from "../../i18n";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { flushNoteEdits } from "./editor/pendingEdits";
import { moveTargets, type NotePlace } from "./queries";

/** The page just created: its title field takes the focus, selected, once. */
export const useFreshNotePage = create<{ id: string | null }>(() => ({
  id: null,
}));

/** Pages deleted from this window: their disappearance is no news (§ 4.3). */
const deletedHere = new Set<string>();

export function wasDeletedHere(id: string): boolean {
  return deletedHere.has(id);
}

/** Tests: the mock backend gives the same ids again after a reset. */
export function forgetDeletedHere(): void {
  deletedHere.clear();
}

/** Group whose name is edited in place (Mac, double click or « Renommer »). */
export const useGroupRename = create<{
  renamingId: string | null;
  /** The « + Nouveau groupe » field of this project is open. */
  creatingIn: string | null;
}>(() => ({ renamingId: null, creatingIn: null }));

/**
 * Creates an untitled page in `groupId` (`null`: outside any group) and opens it, its title
 * ready to type; `sheet`: on the phone, as a full-screen sheet.
 */
export async function createNotePage(
  subjectId: string,
  groupId: string | null,
  sheet: boolean,
): Promise<void> {
  const page = await run(
    commands.createNotePage({
      subjectId,
      groupId,
      title: strings.notes.untitled,
      body: "",
      kind: "page",
      sourceTaskId: null,
    }),
    strings.notes.errors.createPage,
  );
  if (!page) return;
  useFreshNotePage.setState({ id: page.id });
  useUi.getState().openNotePage(subjectId, page.id, sheet);
}

export async function createNoteGroup(
  subjectId: string,
  name: string,
): Promise<boolean> {
  const group = await run(
    commands.createNoteGroup({ subjectId, name: name.trim() }),
    strings.notes.errors.createGroup,
  );
  return group !== undefined;
}

export async function renameNoteGroup(
  id: string,
  name: string,
): Promise<boolean> {
  const group = await run(
    commands.updateNoteGroup({ id, name: name.trim() }),
    strings.notes.errors.updateGroup,
  );
  return group !== undefined;
}

/** « + Nouveau groupe » on a phone: a small dialog (no field in the list under the finger). */
export function promptNewGroup(subjectId: string): void {
  void promptDialog({
    title: strings.notes.newGroup,
    fields: [{ name: "name", label: strings.notes.groupName, required: true }],
    confirmLabel: strings.common.add,
    submit: {
      run: (v) =>
        commands.createNoteGroup({ subjectId, name: (v.name ?? "").trim() }),
      action: strings.notes.errors.createGroup,
    },
  });
}

/** Items of a group's « … »; `inPlace`: « Renommer » edits the title in the list (Mac). */
export function groupMenuItems(group: NoteGroup, inPlace: boolean): MenuItem[] {
  return [
    {
      label: strings.notes.newPageHere,
      // On a large screen the page opens beside the list; on the phone, in its sheet.
      onSelect: () => void createNotePage(group.subjectId, group.id, !inPlace),
    },
    {
      label: strings.notes.rename,
      onSelect: () => {
        if (inPlace) {
          // After the menu closed and gave the focus back.
          setTimeout(
            () => useGroupRename.setState({ renamingId: group.id }),
            0,
          );
          return;
        }
        void promptDialog({
          title: strings.notes.renameGroup,
          fields: [
            {
              name: "name",
              label: strings.notes.groupName,
              initial: group.name,
              required: true,
            },
          ],
          submit: {
            run: (v) =>
              commands.updateNoteGroup({
                id: group.id,
                name: (v.name ?? "").trim(),
              }),
            action: strings.notes.errors.updateGroup,
          },
        });
      },
    },
    { separator: true },
    {
      label: strings.common.delete,
      danger: true,
      onSelect: () => void deleteNoteGroup(group),
    },
  ];
}

async function deleteNoteGroup(group: NoteGroup): Promise<void> {
  const ok = await confirmDialog({
    title: strings.notes.deleteGroupTitle(group.name),
    message: strings.notes.deleteGroupText,
  });
  if (!ok) return;
  await run(
    commands.deleteNoteGroup(group.id),
    strings.notes.errors.deleteGroup,
  );
}

/** What the page menu needs to know about a page. */
export interface PageRef {
  id: string;
  title: string;
  kind: NoteKind;
  place: NotePlace;
}

/** Pins, or unpins (the core puts the page back in its group, at its place). */
async function setPinned(page: PageRef, pinned: boolean): Promise<void> {
  await flushNoteEdits();
  await run(
    commands.pinNotePage({ id: page.id, pinned }),
    strings.notes.errors.movePage,
  );
}

/** « Dupliquer »: the core places the copy; it opens where the original was shown. */
async function duplicate(subjectId: string, id: string): Promise<void> {
  // The copy takes the last characters typed.
  await flushNoteEdits();
  const copy = await run(
    commands.duplicateNotePage(id),
    strings.notes.errors.createPage,
  );
  if (!copy) return;
  const ui = useUi.getState();
  ui.openNotePage(subjectId, copy.id, ui.notePageSheet === id);
}

/** Deletes a page; the toast's « Annuler » brings it back. */
export async function deleteNotePage(id: string): Promise<void> {
  // Saved first, so « Annuler » brings the page back whole (and no save fails after).
  await flushNoteEdits();
  const ui = useUi.getState();
  if (ui.notePageSheet === id) ui.closeNotePageSheet();
  deletedHere.add(id);
  const done = await run(
    commands.deleteNotePage(id),
    strings.notes.errors.deletePage,
  );
  if (done === undefined) {
    deletedHere.delete(id);
    return;
  }
  showToast({
    message: strings.notes.deleted,
    action: {
      label: strings.toast.undo,
      onAction: () => {
        deletedHere.delete(id);
        void run(commands.restoreNotePage(id), strings.notes.errors.deletePage);
      },
    },
  });
}

/**
 * Items of a page's « … » (and right click): Épingler / Désépingler, Déplacer vers…,
 * Dupliquer, Supprimer. « Déplacer vers… » opens a second menu at `at`.
 */
export function pageMenuItems(
  subjectId: string,
  page: PageRef,
  groups: NoteGroup[],
  at: { x: number; y: number },
): MenuItem[] {
  const pinned = page.place === "pinned";
  const targets = moveTargets(page.kind, page.place, groups);
  return [
    {
      label: pinned ? strings.notes.unpin : strings.notes.pin,
      onSelect: () => void setPinned(page, !pinned),
    },
    {
      label: strings.notes.moveTo,
      disabled: targets.length === 0,
      onSelect: () =>
        // After this menu closed.
        setTimeout(
          () =>
            useMenuStore.getState().open(
              at.x,
              at.y,
              targets.map((t) => ({
                label: t.label,
                onSelect: () =>
                  void flushNoteEdits().then(() =>
                    run(
                      commands.moveNotePage({
                        id: page.id,
                        target: t.target,
                        index: null,
                      }),
                      strings.notes.errors.movePage,
                    ),
                  ),
              })),
              strings.notes.moveToLabel(page.title),
            ),
          0,
        ),
    },
    {
      label: strings.notes.duplicate,
      onSelect: () => void duplicate(subjectId, page.id),
    },
    { separator: true },
    {
      label: strings.common.delete,
      danger: true,
      onSelect: () => void deleteNotePage(page.id),
    },
  ];
}
