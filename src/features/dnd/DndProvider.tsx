/**
 * Drag and drop for the whole window (dnd-kit): reorder subjects in the sidebar (within their
 * level: top-level projects with « Sans projet », or the sub-projects of one parent), reorder tasks within their place, move tasks between sections, drop a task on a
 * sidebar subject, and in « À faire » reorder tasks across the places of one project group,
 * move them to another group and reorder whole groups by their header; in the calendar of
 * « Prochainement », move a task to another day (2026-10-12); in a project's notebook, move
 * a page to another group, pin it on « Épinglées », or reorder it in its group (2026-10-14).
 */

import {
  type Active,
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { type ReactNode, useState } from "react";
import type { NoteKind, NoteTarget, TaskRow } from "../../bindings";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { longDay } from "../views/upcomingModel";
import { useDragSensors } from "./sensors";

/** Where a task lives: `subjectId: null` = « Sans projet », `sectionId: null` = outside sections. */
export interface Place {
  subjectId: string | null;
  sectionId: string | null;
}

/** A row with its place, as a group lists it (« À faire » mixes places in one group). */
export type PlacedRow = Pick<TaskRow, "id" | "subjectId" | "sectionId">;

export type DragData =
  | {
      type: "task";
      taskId: string;
      title: string;
      /** The row's own place (in « À faire », each row has its own). */
      place: Place;
      groupId: string;
      /** Index among the open tasks of its group. */
      index: number;
      /** Rows of Inbox, Subject and « À faire » views can be reordered. */
      reorderable: boolean;
      /** Rows of its group in display order (drop index, `dropIndex`). */
      groupRows: readonly PlacedRow[];
      /**
       * « Prochainement » list (2026-10-12): the row's due date and time; dropped on another
       * day, the task is due there, its time kept.
       */
      day?: { date: string | null; time: string | null };
    }
  | {
      /** A sidebar row: a project, or « Sans projet » (`subjectId: null`). */
      type: "subject";
      subjectId: string | null;
      name: string;
      /**
       * Index in its level: the top-level order (« Sans projet » counted, even hidden), or
       * the parent's sub-projects.
       */
      index: number;
      /** Its parent project; a drag stays within one level. */
      parentId: string | null;
    }
  | {
      /** A « À faire » group, dragged by its header; `subjectId: null` = « Sans projet ». */
      type: "project_group";
      subjectId: string | null;
      name: string;
      /** Index in its level, as the core gives it (`TaskGroup.order`). */
      index: number;
      parentId: string | null;
      groupId: string;
      /** Where a task dropped on the group goes: the project, no section (appended). */
      place: Place;
    }
  | {
      type: "group";
      groupId: string;
      place: Place;
      reorderable: boolean;
      /** A day of the « Prochainement » list: a task dropped there is due that day. */
      date?: string;
    }
  | {
      /** A task of the « Prochainement » calendar: it moves to another day, time kept. */
      type: "calendar_task";
      taskId: string;
      title: string;
      date: string;
      time: string | null;
    }
  | {
      /** A day of the calendar (today or later). */
      type: "calendar_day";
      date: string;
      label: string;
    }
  | {
      /** A page of a project's notebook (its list). */
      type: "note_page";
      pageId: string;
      title: string;
      kind: NoteKind;
      subjectId: string;
      /** Its block: « Épinglées », outside any group, a group, « Résumés de tâches ». */
      place: NoteTarget;
      /** Ids of its block's pages in display order (drop index, `dropIndex`). */
      blockPages: readonly string[];
    }
  | {
      /** A block of the notebook (header and margins): a page dropped there goes to its end. */
      type: "note_group_drop";
      subjectId: string;
      place: NoteTarget;
      name: string;
    };

export const dragId = {
  task: (id: string) => `task:${id}`,
  subject: (id: string) => `subject:${id}`,
  /** The sidebar « Sans projet » row. */
  inbox: () => "inbox",
  projectGroup: (groupId: string) => `project-group:${groupId}`,
  group: (id: string) => `group:${id}`,
  calendarTask: (id: string) => `calendar-task:${id}`,
  calendarDay: (date: string) => `calendar-day:${date}`,
  notePage: (id: string) => `note-page:${id}`,
  noteBlock: (subjectId: string, place: NoteTarget) =>
    `note-block:${subjectId}:${typeof place === "object" ? place.group.id : place}`,
};

const PRIORITY: Record<DragData["type"], number> = {
  subject: 0,
  task: 1,
  project_group: 2,
  group: 3,
  calendar_task: 4,
  calendar_day: 4,
  note_page: 1,
  note_group_drop: 3,
};

const dataOf = (x: { data: { current?: unknown } } | null | undefined) =>
  (x?.data.current as DragData | undefined) ?? undefined;

/** Level of a sidebar project (its parent id), `undefined` for anything else. */
const levelOf = (data: DragData | undefined) =>
  data?.type === "subject" ? data.parentId : undefined;

const sameNotePlace = (a: NoteTarget, b: NoteTarget) =>
  typeof a === "object" && typeof b === "object"
    ? a.group.id === b.group.id
    : a === b;

/**
 * True when a notebook block `place` (of project `subjectId`) receives the dragged page:
 * « Épinglées » pins it (but is not reordered: a pinned page is refused there), a group takes
 * any page, and outside any group plain pages and summaries keep their own lists (a plain
 * page never lands in « Résumés de tâches », a summary never among the plain pages).
 */
export function notePageAccepts(
  page: Extract<DragData, { type: "note_page" }>,
  place: NoteTarget,
  subjectId: string = page.subjectId,
): boolean {
  if (subjectId !== page.subjectId) return false;
  if (place === "pinned") return page.place !== "pinned";
  if (place === "ungrouped") return page.kind !== "summary";
  if (place === "summaries") return page.kind === "summary";
  return true;
}

/**
 * True when `data` can receive the dragged `active`: a project (sidebar row or « À faire »
 * group) only lands among the projects of its own level and kind; a task
 * lands anywhere.
 */
function accepts(active: DragData | undefined, data: DragData | undefined) {
  if (data === undefined) return false;
  // A notebook page lands in its notebook only, and only a page lands there.
  if (active?.type === "note_page") {
    return (
      (data.type === "note_page" || data.type === "note_group_drop") &&
      notePageAccepts(active, data.place, data.subjectId)
    );
  }
  if (data.type === "note_page" || data.type === "note_group_drop") {
    return false;
  }
  // A calendar task lands on a calendar day only, and only a calendar task lands there.
  if (active?.type === "calendar_task") return data.type === "calendar_day";
  if (data.type === "calendar_day") return false;
  if (active?.type === "subject" || active?.type === "project_group") {
    return data.type === active.type && data.parentId === active.parentId;
  }
  return true;
}

/**
 * Pointer: what is under the pointer, subjects first (dropping a task on the sidebar; a
 * sub-project before its parent, whose drop area wraps it), then tasks, then project groups
 * and group containers. Keyboard: closest item of the same kind (and level, for projects).
 */
const collisionDetection: CollisionDetection = (args) => {
  const active = dataOf(args.active);
  const find = (id: string | number) =>
    dataOf(args.droppableContainers.find((c) => c.id === id));
  if (args.pointerCoordinates) {
    const hits = pointerWithin(args).filter((hit) =>
      accepts(active, find(hit.id)),
    );
    const rank = (id: string | number) => {
      const data = find(id);
      const type = data?.type ?? "group";
      // A sub-project wins over its parent (whose node also holds the sub-projects).
      const nested = levelOf(data) ? 0 : 0.5;
      return PRIORITY[type] + (type === "subject" ? nested : 0);
    };
    return hits.sort((a, b) => rank(a.id) - rank(b.id));
  }
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => {
      const data = dataOf(c);
      const kind =
        active?.type === "calendar_task" ? "calendar_day" : active?.type;
      return data?.type === kind && accepts(active, data);
    }),
  });
};

const samePlace = (a: Place, b: Place) =>
  a.subjectId === b.subjectId && a.sectionId === b.sectionId;

/**
 * Index a task dropped on `targetId` takes within the target's place, from the rows of the
 * target's group in display order: the rows are reordered as the list showed it during the
 * drag (the moving row takes the target's slot), then the rows of the target's place before
 * it are counted. In a group of one place (a project view) it is the target's index; in
 * « À faire », where a project group flattens its sections, it is the index within the
 * target's section.
 */
export function dropIndex(
  rows: readonly PlacedRow[],
  movingId: string,
  targetId: string,
): number {
  const ids = rows.map((r) => r.id);
  const to = ids.indexOf(targetId);
  const target = rows[to];
  if (!target) return 0;
  const from = ids.indexOf(movingId);
  const order =
    from === -1
      ? [...ids.slice(0, to), movingId, ...ids.slice(to)]
      : arrayMove(ids, from, to);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let index = 0;
  for (const id of order) {
    if (id === movingId) break;
    const row = byId.get(id);
    if (row && samePlace(row, target)) index += 1;
  }
  return index;
}

/** Reorders a project or « Sans projet » (`subjectId: null`) at `index` in its level. */
function reorderProject(subjectId: string | null, index: number) {
  return run(
    subjectId === null
      ? commands.reorderInbox(index)
      : commands.reorderSubject({ id: subjectId, index }),
    fr.errors.action.reorder,
  );
}

/** A notebook page dropped on a page (that slot) or on a block (its end). */
async function dropNotePage(
  from: Extract<DragData, { type: "note_page" }>,
  to: DragData,
) {
  if (to.type !== "note_page" && to.type !== "note_group_drop") return;
  if (!notePageAccepts(from, to.place, to.subjectId)) return;
  const same = sameNotePlace(from.place, to.place);
  let index: number | null = null;
  if (to.type === "note_page" && to.place !== "pinned") {
    const rows = to.blockPages.map((id) => ({
      id,
      subjectId: null,
      sectionId: null,
    }));
    index = dropIndex(rows, from.pageId, to.pageId);
    if (same && index === from.blockPages.indexOf(from.pageId)) return;
  } else if (same) {
    // Its own block's area: nothing moves.
    return;
  }
  await run(
    commands.moveNotePage({ id: from.pageId, target: to.place, index }),
    fr.notes.errors.movePage,
  );
}

/** Pointer or finger travel under which a held page counts as not moved. */
export const STILL_PX = 8;

/** True when the drag ended about where it started (a long press held still). */
export function heldStill(event: Pick<DragEndEvent, "delta">): boolean {
  const { x, y } = event.delta ?? { x: 0, y: 0 };
  return Math.hypot(x, y) < STILL_PX;
}

export async function handleDragEnd(event: DragEndEvent) {
  const { active, over } = event;
  const from = dataOf(active);
  const to = dataOf(over);
  if (!from || !to || active.id === over?.id) return;
  if (from.type === "note_page") {
    // Held still then released: only its menu opens (on a touch screen), it is not dropped
    // on whatever lies under the finger.
    if (heldStill(event)) return;
    await dropNotePage(from, to);
    return;
  }
  if (to.type === "note_page" || to.type === "note_group_drop") return;

  // A project among its level: sidebar row on sidebar row, « À faire » group on group.
  if (
    (from.type === "subject" && to.type === "subject") ||
    (from.type === "project_group" && to.type === "project_group")
  ) {
    // Within one level only; moving between levels goes through « Déplacer vers… ».
    if (from.parentId !== to.parentId || from.subjectId === to.subjectId) {
      return;
    }
    await reorderProject(from.subjectId, to.index);
    return;
  }
  // Calendar: the task is due on the day it was dropped on, at the same time.
  if (from.type === "calendar_task") {
    if (to.type !== "calendar_day" || to.date === from.date) return;
    const moved = await run(
      commands.setTaskDue({ id: from.taskId, date: to.date, time: from.time }),
      fr.errors.action.updateTask,
    );
    if (moved) showToast({ message: fr.upcoming.movedTo(to.label) });
    return;
  }
  if (from.type !== "task") return;

  if (to.type === "subject") {
    if (
      from.place.subjectId === to.subjectId &&
      from.place.sectionId === null
    ) {
      return;
    }
    const moved = await run(
      commands.moveTask({
        id: from.taskId,
        subjectId: to.subjectId,
        sectionId: null,
        index: null,
      }),
    );
    if (moved) showToast({ message: fr.toast.moved(to.name) });
    return;
  }
  // « Prochainement » list: dropped on another day, the task is due there (time kept).
  if (from.day) {
    const date =
      to.type === "group" ? to.date : to.type === "task" ? to.day?.date : null;
    if (!date || date === from.day.date) return;
    const moved = await run(
      commands.setTaskDue({ id: from.taskId, date, time: from.day.time }),
      fr.errors.action.updateTask,
    );
    if (moved) showToast({ message: fr.upcoming.movedTo(longDay(date)) });
    return;
  }
  if (!from.reorderable) return;
  // « À faire »: dropped on another project's group area, appended to that project.
  if (to.type === "project_group") {
    if (to.groupId === from.groupId) return;
    await run(
      commands.moveTask({
        id: from.taskId,
        subjectId: to.place.subjectId,
        sectionId: null,
        index: null,
      }),
    );
    return;
  }
  if (to.type === "calendar_task" || to.type === "calendar_day") return;
  if (!to.reorderable) return;
  if (to.type === "task") {
    await run(
      commands.moveTask({
        id: from.taskId,
        subjectId: to.place.subjectId,
        sectionId: to.place.sectionId,
        index: dropIndex(to.groupRows, from.taskId, to.taskId),
      }),
    );
    return;
  }
  if (to.groupId !== from.groupId) {
    await run(
      commands.moveTask({
        id: from.taskId,
        subjectId: to.place.subjectId,
        sectionId: to.place.sectionId,
        index: null,
      }),
    );
  }
}

/** Name read to screen readers for a dragged item or a drop target. */
function spokenName(x: { data: { current?: unknown } } | null) {
  const data = dataOf(x);
  if (data?.type === "task" || data?.type === "calendar_task") {
    return data.title;
  }
  if (data?.type === "calendar_day") return data.label;
  if (data?.type === "subject" || data?.type === "project_group") {
    return data.name;
  }
  if (data?.type === "note_page") return data.title;
  if (data?.type === "note_group_drop") return data.name;
  return undefined;
}

/** dnd-kit's live announcements, in French and with names instead of ids. */
const announcements: Announcements = {
  onDragStart: ({ active }) => {
    const name = spokenName(active);
    return name === undefined ? undefined : fr.dnd.pickedUp(name);
  },
  onDragOver: ({ active, over }) => {
    const target = spokenName(over);
    return target === undefined || active.id === over?.id
      ? undefined
      : fr.dnd.over(target);
  },
  onDragEnd: ({ over }) => {
    const target = spokenName(over);
    return target === undefined ? fr.dnd.dropped : fr.dnd.droppedOn(target);
  },
  onDragCancel: () => fr.dnd.cancelled,
};

export function DndProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const sensors = useDragSensors(5);
  const activeData = dataOf(active);

  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: fr.dnd.instructions },
      }}
      collisionDetection={collisionDetection}
      onDragStart={(e: DragStartEvent) => setActive(e.active)}
      onDragCancel={() => setActive(null)}
      onDragEnd={(e) => {
        setActive(null);
        void handleDragEnd(e);
      }}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeData?.type === "task" ||
        activeData?.type === "calendar_task" ||
        activeData?.type === "note_page" ? (
          <div className="max-w-[360px] truncate rounded-md border border-border bg-elevated px-3 py-2 text-[14px] shadow-pop">
            {activeData.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
