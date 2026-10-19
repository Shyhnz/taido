/**
 * A TaskRow wired to the stores, the menus, drag and drop and the list keyboard
 * (audit A2, step 15): one tab stop per list (roving tabindex), ↑/↓ and j/k move, Space
 * checks, Enter opens, ⌥↑/⌥↓ reorder, the context-menu key opens the ⋯ menu.
 *
 * A task's subtasks show indented under it (Todoist), folded by the chevron
 * or → / ← on the row; ← on a subtask goes back to its task. Subtask rows open their own
 * panel and check themselves; they are not dragged (their order lives in the panel).
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import type { TaskRow as TaskRowData, ViewKind } from "../../bindings";
import { openContextMenu, openMenuAt } from "../../components/Menu";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { features } from "../../lib/features";
import { useSubjects } from "../../lib/queries";
import { useUi } from "../../stores/ui";
import {
  type DragData,
  dragId,
  type Place,
  type PlacedRow,
} from "../dnd/DndProvider";
import { isTouchContextMenu, splitTouchListeners } from "../dnd/sensors";
import { useList } from "../views/listStore";
import {
  completeFromRow,
  fileMenuItems,
  forgetCompletion,
  moveTaskBy,
  setCompleted,
  taskMenuItems,
  useCompletion,
} from "./actions";
import { TaskRow } from "./TaskRow";

/** Id of the row that holds the list's tab stop: the selection, else the first row. */
function useIsTabStop(id: string): boolean {
  return useUi((s) => {
    const selected = s.visibleTasks.some((t) => t.id === s.selectedTaskId)
      ? s.selectedTaskId
      : (s.visibleTasks[0]?.id ?? null);
    return selected === id;
  });
}

function focusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-task-list] [data-row-focus]"),
  );
}

/** Moves the focus to another row of the list (DOM order across groups). */
function focusSibling(
  from: HTMLElement,
  to: "next" | "prev" | "first" | "last",
) {
  const all = focusables();
  const index = all.indexOf(from);
  const target =
    to === "first"
      ? all[0]
      : to === "last"
        ? all.at(-1)
        : to === "next"
          ? all[index + 1]
          : all[index - 1];
  target?.focus();
  target?.scrollIntoView?.({ block: "nearest" });
}

interface RowWiring {
  row: TaskRowData;
  /** Reordering with ⌥↑/⌥↓ (null when the group is computed, e.g. Today). */
  reorder: { place: Place; index: number; size: number } | null;
  /** Shows « Ranger dans… » (tasks of « Sans projet »). */
  canFile: boolean;
  /** The completion animation applies to open rows only. */
  animated: boolean;
}

/** Everything a list row needs besides drag and drop. */
function useRowWiring({ row, reorder, canFile, animated }: RowWiring) {
  const selected = useUi((s) => s.selectedTaskId === row.id);
  const isTabStop = useIsTabStop(row.id);
  const openTask = useUi((s) => s.openTask);
  const selectTask = useUi((s) => s.selectTask);
  const completing = useCompletion((s) =>
    animated ? s.phases[row.id] : undefined,
  );
  const pendingFocus = useList((s) => s.pendingFocusId === row.id);
  const subjects = useSubjects().data ?? [];
  const focusRef = useRef<HTMLButtonElement>(null);
  const completed = row.completedAt !== null;
  const hasChildren = row.children.length > 0;
  const childrenOpen = useUi((s) => s.collapsedTasks[row.id] !== true);
  const toggleChildren = useUi((s) => s.toggleChildren);

  // A row asked to take the focus (after a completion, a move…).
  useEffect(() => {
    if (!pendingFocus) return;
    focusRef.current?.focus();
    useList.getState().focusRow(null);
  }, [pendingFocus]);

  // A checked row leaves the open list: its completion animation is over.
  useEffect(() => {
    if (!animated) return;
    const id = row.id;
    return () => forgetCompletion(id);
  }, [animated, row.id]);

  // The selection moved with the global ↑/↓ while the focus was in the list or nowhere.
  useEffect(() => {
    if (!selected) return;
    const el = focusRef.current;
    const active = document.activeElement;
    if (!el || active === el) return;
    const inList =
      active instanceof HTMLElement &&
      active.closest("[data-task-list]") !== null;
    if (active === document.body || active === null || inList) el.focus();
  }, [selected]);

  const agent = useDefaultAgent();
  const menu = () => taskMenuItems(row, agent);
  const toggle = () => {
    if (completed) void setCompleted(row.id, false);
    else if (animated) completeFromRow(row.id);
    else void setCompleted(row.id, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey;
    if (e.altKey && plain && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (reorder) {
        void moveTaskBy(
          row,
          reorder.place,
          reorder.index,
          reorder.size,
          e.key === "ArrowUp" ? -1 : 1,
        );
      }
      return;
    }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      openMenuAt(el, menu(), row.title);
      return;
    }
    if (!plain || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        focusSibling(el, "next");
        return;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        focusSibling(el, "prev");
        return;
      case "Home":
        e.preventDefault();
        focusSibling(el, "first");
        return;
      case "End":
        e.preventDefault();
        focusSibling(el, "last");
        return;
      // Like a tree: → unfolds the subtasks, ← folds them, or goes back to the parent.
      case "ArrowRight":
        if (!hasChildren) return;
        e.preventDefault();
        toggleChildren(row.id, true);
        return;
      case "ArrowLeft":
        if (hasChildren && childrenOpen) {
          e.preventDefault();
          toggleChildren(row.id, false);
        } else if (row.parentId !== null && parentRowShown(row.parentId)) {
          e.preventDefault();
          useUi.getState().selectTask(row.parentId);
          useList.getState().focusRow(row.parentId);
        }
        return;
      case " ":
        // Space checks the task instead of clicking the title (keyboard: no animation).
        e.preventDefault();
        void setCompleted(row.id, !completed);
        return;
      default:
        return;
    }
  };

  return {
    selected,
    tabIndex: isTabStop ? 0 : -1,
    focusRef,
    completing,
    onKeyDown,
    onFocus: () => {
      if (!selected) selectTask(row.id);
    },
    onOpen: () => openTask(row.id),
    onToggle: toggle,
    // Touch screen: the long press picks the row up; its menu stays on the ⋯ button.
    onContextMenu: (e: MouseEvent) =>
      isTouchContextMenu(e)
        ? e.preventDefault()
        : openContextMenu(e, menu(), row.title),
    onMenu: (anchor: HTMLElement) =>
      openMenuAt(anchor, menu(), row.title, true),
    onFile:
      canFile && subjects.length > 0
        ? (anchor: HTMLElement) =>
            openMenuAt(anchor, fileMenuItems(row, subjects), t.list.file, true)
        : undefined,
    childrenOpen,
    onToggleChildren: hasChildren ? () => toggleChildren(row.id) : undefined,
  };
}

/** True when the row of `taskId` is rendered in a list (a subtask's way back with ←). */
function parentRowShown(taskId: string): boolean {
  return focusables().some((el) => el.dataset.rowFocus === taskId);
}

/** A subtask under its task: indented, its own ring, dot and due; no drag, no animation. */
function ChildTaskRow({
  row,
  shownDate,
}: {
  row: TaskRowData;
  shownDate?: string;
}) {
  const wiring = useRowWiring({
    row,
    reorder: null,
    canFile: false,
    animated: false,
  });
  return <TaskRow row={row} {...wiring} shownDate={shownDate} />;
}

/**
 * The subtasks of a list row, indented under it so their checkbox lines up with the task's
 * title (Todoist). Nothing when the task has none or when they are folded.
 */
export function TaskChildren({
  row,
  shownDate,
}: {
  row: TaskRowData;
  /** The date the group already shows (see `TaskRow`). */
  shownDate?: string;
}) {
  const open = useUi((s) => s.collapsedTasks[row.id] !== true);
  if (row.children.length === 0 || !open) return null;
  return (
    <ul
      data-subtasks={row.id}
      aria-label={t.nesting.childrenLabel(row.title)}
      className="ml-[30px] flex flex-col"
    >
      {row.children.map((child) => (
        <li key={child.id}>
          {/* Under its task, a subtask's project label would only repeat the parent's. */}
          <ChildTaskRow
            row={{ ...child, subject: null }}
            shownDate={shownDate}
          />
        </li>
      ))}
    </ul>
  );
}

/** A row of the « Terminées » fold (not sortable, no completion animation). */
export function ConnectedTaskRow({ row }: { row: TaskRowData }) {
  const wiring = useRowWiring({
    row,
    reorder: null,
    canFile: false,
    animated: false,
  });
  return (
    <>
      <TaskRow row={row} {...wiring} />
      <TaskChildren row={row} />
    </>
  );
}

/**
 * ⌥↑ / ⌥↓ of a row: within its place. In « À faire » (`mixed`), a project group flattens its
 * sections, so the index and the bound count only the group's rows of the same place.
 */
export function rowReorder(
  row: PlacedRow,
  index: number,
  size: number,
  place: Place | null,
  groupRows: readonly PlacedRow[],
  mixed: boolean,
): { place: Place; index: number; size: number } | null {
  if (!mixed) return place ? { place, index, size } : null;
  const own = { subjectId: row.subjectId, sectionId: row.sectionId };
  const same = groupRows.filter(
    (r) => r.subjectId === own.subjectId && r.sectionId === own.sectionId,
  );
  return {
    place: own,
    index: same.findIndex((r) => r.id === row.id),
    size: same.length,
  };
}

export function SortableTaskRow({
  row,
  index,
  size,
  groupId,
  place,
  viewKind,
  shownDate,
  mixed = false,
  groupRows,
}: {
  row: TaskRowData;
  index: number;
  /** Number of open tasks in the group (⌥↓ bound). */
  size: number;
  groupId: string;
  /** Place of the group, or `null` when it is not one place (Today, « À faire »…). */
  place: Place | null;
  viewKind: ViewKind;
  /** The date the group already shows (see `TaskRow`). */
  shownDate?: string;
  /**
   * « À faire »: the group mixes the sections of a project; each row has its own place and
   * can still be reordered or moved.
   */
  mixed?: boolean;
  /** Rows of the group in display order (where a task dropped on this row lands). */
  groupRows: readonly PlacedRow[];
}) {
  const reorderable = place !== null || mixed;
  const rowPlace: Place = mixed
    ? { subjectId: row.subjectId, sectionId: row.sectionId }
    : (place ?? { subjectId: row.subjectId, sectionId: row.sectionId });
  const wiring = useRowWiring({
    row,
    reorder: rowReorder(row, index, size, place, groupRows, mixed),
    canFile: viewKind === "inbox",
    animated: true,
  });
  const data: DragData = {
    type: "task",
    taskId: row.id,
    title: row.title,
    place: rowPlace,
    groupId,
    index,
    reorderable,
    groupRows,
    // « Prochainement »: the row moves to the day it is dropped on (2026-10-12).
    ...(viewKind === "upcoming"
      ? { day: { date: row.due?.date ?? null, time: row.due?.time ?? null } }
      : {}),
  };
  const movable = reorderable || viewKind === "upcoming";
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: dragId.task(row.id),
    data,
    // Computed groups cannot be reordered: rows stay draggable (to the sidebar) only.
    disabled: features.dragAndDrop
      ? reorderable
        ? false
        : { droppable: true }
      : { draggable: true, droppable: true },
  });
  // Mouse: the grip, like on the Mac. Finger (web app): a long press anywhere on the row; on
  // a phone the sidebar is a closed drawer, so only reorderable rows are picked up (and the
  // rows of « Prochainement », which move from day to day). Only the
  // touch listener on the row: dnd-kit's attributes would add a second tab stop to it.
  const { grip: gripListeners, onTouchStart } = splitTouchListeners(listeners);

  // The subtasks move with their task while it is dragged.
  return (
    <div
      ref={setNodeRef}
      onTouchStart={movable ? onTouchStart : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
    >
      <TaskRow
        row={row}
        {...wiring}
        shownDate={shownDate}
        dragHandle={
          features.dragAndDrop && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...gripListeners}
              // Keyboard users reorder with ⌥↑/⌥↓ on the row: the handle leaves the tab order.
              tabIndex={-1}
              aria-label={`${t.row.dragHandle} · ${row.title}`}
              onClick={(e) => e.stopPropagation()}
              className="drag-grip flex h-6 w-4 cursor-grab items-center justify-center rounded text-text-3 hover:text-text-2"
            >
              <GripVertical size={14} aria-hidden />
            </button>
          )
        }
      />
      <TaskChildren row={row} shownDate={shownDate} />
    </div>
  );
}
