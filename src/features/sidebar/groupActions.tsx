/**
 * Groups of projects (Taido V2.2 bis): like Brave's tab groups, only visual. Select
 * projects (⌘-clic, ⇧-clic), right-click › « Ajouter à un groupe » › « Nouveau groupe » or an
 * existing one. A group's label folds its projects; its menu renames it, changes its color or
 * dissolves it (« Dégrouper »: the projects stay). A group holds no task.
 */

import { create } from "zustand";
import type { Subject } from "../../bindings";
import { type MenuItem, useMenuStore } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { SUBJECT_COLORS } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { ColorSwatch } from "./ColorSwatch";
import { useProjectRename } from "./subjectActions";

/** Projects selected in the sidebar with ⌘-clic / ⇧-clic. */
export const useProjectSelection = create<{
  ids: string[];
  /** Last project clicked: the start of a ⇧-clic range. */
  anchor: string | null;
  toggle: (id: string) => void;
  range: (id: string, order: string[]) => void;
  clear: () => void;
}>((set, get) => ({
  ids: [],
  anchor: null,
  toggle: (id) =>
    set((s) => ({
      ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
      anchor: id,
    })),
  range: (id, order) => {
    const anchor = get().anchor ?? id;
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) {
      set({ ids: [id], anchor: id });
      return;
    }
    const [from, to] = a < b ? [a, b] : [b, a];
    set({ ids: order.slice(from, to + 1), anchor });
  },
  clear: () => set({ ids: [], anchor: null }),
}));

/** The groups among the projects (flat list). */
export function groupsOf(subjects: Subject[]): Subject[] {
  return subjects.filter((s) => s.isGroup);
}

/** Projects that can hold tasks: every subject but the groups. */
export function taskProjects(subjects: Subject[]): Subject[] {
  return subjects.filter((s) => !s.isGroup);
}

/** « Nouveau groupe » or an existing one; a new group unfolds and takes its name at once. */
export async function addToGroup(projectIds: string[], group: Subject | null) {
  const id = await run(
    commands.groupProjects({
      projectIds,
      groupId: group?.id ?? null,
      name: null,
    }),
    t.groups.error,
  );
  useProjectSelection.getState().clear();
  if (!id) return;
  useUi.getState().toggleSubProjects(id, true);
  if (!group) {
    // Named in place, like Brave asks for the name of a new group.
    setTimeout(() => useProjectRename.getState().start(id), 0);
  }
}

export async function removeFromGroup(projectIds: string[]) {
  await run(commands.ungroupProjects(projectIds), t.groups.error);
  useProjectSelection.getState().clear();
}

/** Items of « Ajouter à un groupe ›»: a new group, then every group the projects are not all in. */
function targetItems(projectIds: string[], subjects: Subject[]): MenuItem[] {
  const inside = (g: Subject) =>
    projectIds.every(
      (id) => subjects.find((s) => s.id === id)?.parentId === g.id,
    );
  const groups = groupsOf(subjects).filter((g) => !inside(g));
  return [
    {
      label: t.groups.newGroup,
      onSelect: () => void addToGroup(projectIds, null),
    },
    ...(groups.length > 0 ? [{ separator: true } as MenuItem] : []),
    ...groups.map((g) => ({
      label: t.groups.into(g.name),
      icon: <ColorSwatch color={g.color} />,
      onSelect: () => void addToGroup(projectIds, g),
    })),
  ];
}

/** « Ajouter à un groupe › » and « Retirer du groupe », for one project or a selection. */
export function projectGroupItems(
  projectIds: string[],
  subjects: Subject[],
  position: { x: number; y: number },
): MenuItem[] {
  const grouped = projectIds.some(
    (id) => subjects.find((s) => s.id === id)?.parentId,
  );
  return [
    {
      label: t.groups.addTo,
      hint: "›",
      onSelect: () => {
        // Opened right after the parent menu closes.
        setTimeout(() => {
          useMenuStore
            .getState()
            .open(
              position.x,
              position.y,
              targetItems(projectIds, subjects),
              t.groups.addToLabel(projectIds.length),
            );
        }, 0);
      },
    },
    ...(grouped
      ? [
          {
            label: t.groups.remove,
            onSelect: () => void removeFromGroup(projectIds),
          },
        ]
      : []),
  ];
}

/** The menu of a group's label: rename, color, « Dégrouper ». */
export function groupMenuItems(
  group: Subject,
  position: { x: number; y: number },
): MenuItem[] {
  return [
    {
      label: t.groups.rename,
      onSelect: () => {
        setTimeout(() => useProjectRename.getState().start(group.id), 0);
      },
    },
    {
      label: t.groups.color,
      hint: "›",
      onSelect: () => {
        setTimeout(() => {
          useMenuStore.getState().open(
            position.x,
            position.y,
            SUBJECT_COLORS.map((color) => ({
              label: t.subject.colors[color],
              icon: <ColorSwatch color={color} />,
              checked: group.color === color ? true : undefined,
              onSelect: () => {
                void run(
                  commands.updateSubject({
                    id: group.id,
                    name: null,
                    color,
                    rootPath: null,
                    parentId: null,
                  }),
                  t.groups.error,
                );
              },
            })),
            t.groups.color,
          );
        }, 0);
      },
    },
    { separator: true },
    {
      label: t.groups.dissolve,
      onSelect: async () => {
        const done = await run(
          commands.dissolveGroup(group.id),
          t.groups.error,
        );
        if (done !== undefined) {
          showToast({ message: t.groups.dissolved(group.name) });
        }
      },
    },
  ];
}
