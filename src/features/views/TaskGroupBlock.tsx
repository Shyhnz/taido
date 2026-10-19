/**
 * One group of a view: optional header (sections, « En retard », « Claude
 * attend »), sortable rows, and one « + Ajouter… » line whose editor opens in place.
 *
 * « À faire »: each project group is itself sortable, dragged by its header (pointer on the
 * Mac, long press on the phone) to reorder projects and « Sans projet »; its rows keep their
 * own place, so they are reordered and moved across groups like in a project view.
 */

import { type DraggableSyntheticListeners, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, Ellipsis, Plus } from "lucide-react";
import { useCallback } from "react";
import type { Subject, TaskGroup, TaskRow, ViewKind } from "../../bindings";
import { openContextMenu, openMenuAt } from "../../components/Menu";
import { showToast } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { useDefaultAgent } from "../../lib/agent";
import { todayString } from "../../lib/dates";
import { features } from "../../lib/features";
import { subjectColorVar } from "../../lib/format";
import { commands } from "../../lib/ipc";
import { run } from "../../lib/run";
import { useUi } from "../../stores/ui";
import { type DragData, dragId } from "../dnd/DndProvider";
import { isTouchContextMenu } from "../dnd/sensors";
import { ConnectedTaskRow, SortableTaskRow } from "../task-row/SortableTaskRow";
import { groupId, groupPlace, groupTitle, projectGroupDrag } from "./groups";
import { editorKey, useList } from "./listStore";
import { sectionMenuItems } from "./sectionActions";
import { TaskEditor } from "./TaskEditor";

/** Ghost « + Ajouter… » line: gray, never blue (audit V1). */
export function AddTaskRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14px] text-text-3 hover:text-text"
    >
      <span className="flex h-5 w-5 items-center justify-center">
        <Plus size={15} aria-hidden />
      </span>
      {fr.addTask.row}
    </button>
  );
}

/** « Reporter à aujourd'hui » (Today, « En retard » group). */
export async function postponeOverdue() {
  const n = await run(
    commands.rescheduleOverdue(),
    fr.errors.action.updateTask,
  );
  if (n === undefined || n === 0) return;
  const message = fr.list.rescheduled(n);
  showToast({ message });
}

/**
 * Title of a « À faire » group: the project's dot and name (« Globex ›
 * Client » for a sub-project), a link to the project; « Sans projet » opens its list.
 */
function ProjectGroupTitle({
  group,
  title,
}: {
  group: TaskGroup;
  title: string;
}) {
  const key = group.key;
  const setView = useUi((s) => s.setView);
  if (key.type !== "project" && key.type !== "no_project") return null;
  const open = () =>
    setView(
      key.type === "project"
        ? { kind: "subject", subjectId: key.id }
        : { kind: "inbox", subjectId: null },
    );
  return (
    <h2 className="flex min-w-0 text-[14px] font-semibold">
      <button
        type="button"
        onClick={open}
        title={fr.all.openProject(title)}
        className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-hover"
      >
        {key.type === "project" && (
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: subjectColorVar(key.color) }}
          />
        )}
        <span className="truncate">{title}</span>
      </button>
    </h2>
  );
}

/** Pointer (and touch) drag of a « À faire » group by its header. */
interface DragHandle {
  ref: (el: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
}

function GroupHeader({
  group,
  title,
  dragHandle,
}: {
  group: TaskGroup;
  title: string;
  dragHandle?: DragHandle;
}) {
  const key = group.key;
  const section = key.type === "section" ? key : null;
  const menuLabel = section ? fr.section.menu(section.name) : "";
  const count = group.tasks.length;
  const projectGroup = key.type === "project" || key.type === "no_project";
  // No keyboard drag of a group: keyboard users reorder projects in the sidebar (⌥↑ / ⌥↓),
  // and dnd-kit's key listener would take Enter from the title's link.
  const { onKeyDown: _keyboardDrag, ...pointerListeners } =
    dragHandle?.listeners ?? {};

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click shortcut to the same menu as the ⋯ button; pointer drag surface of a « À faire » group
    <header
      ref={dragHandle?.ref}
      {...pointerListeners}
      onContextMenu={
        section
          ? (e) => openContextMenu(e, sectionMenuItems(section), menuLabel)
          : // Touch screen: the long press picks the group up, no native menu.
            dragHandle
            ? (e) => {
                if (isTouchContextMenu(e)) e.preventDefault();
              }
            : undefined
      }
      className={`group/header flex h-8 items-center gap-2 px-2 ${
        dragHandle ? "drag-header" : ""
      }`}
    >
      {projectGroup ? (
        <ProjectGroupTitle group={group} title={title} />
      ) : (
        <h2 className="min-w-0 truncate text-[14px] font-semibold">{title}</h2>
      )}
      {/* A day of « Prochainement » shows its tasks, never « Aucune tâche » (Todoist). */}
      {key.type !== "day" && (
        <span
          className={`text-[12px] text-text-2 tabular-nums ${
            section
              ? "opacity-0 group-focus-within/header:opacity-100 group-hover/header:opacity-100"
              : ""
          }`}
        >
          {fr.list.sectionCount(count)}
        </span>
      )}
      <span className="flex-1" />
      {features.terminals && section?.subpath && (
        <span className="truncate font-mono text-[12.5px] text-text-3">
          {section.subpath}/
        </span>
      )}
      {key.type === "today_overdue" && (
        <button
          type="button"
          onClick={() => void postponeOverdue()}
          className="rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-text-2 hover:bg-hover hover:text-text"
        >
          {fr.views.groups.postponeToToday}
        </button>
      )}
      {section && (
        <button
          type="button"
          aria-label={menuLabel}
          title={fr.common.more}
          onClick={(e) =>
            openMenuAt(
              e.currentTarget,
              sectionMenuItems(section),
              menuLabel,
              true,
            )
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-2 opacity-0 hover:bg-hover hover:text-text focus-visible:opacity-100 group-hover/header:opacity-100"
        >
          <Ellipsis size={15} aria-hidden />
        </button>
      )}
    </header>
  );
}

export function TaskGroupBlock({
  group,
  viewKind,
  subject,
}: {
  group: TaskGroup;
  viewKind: ViewKind;
  subject: Subject | null;
}) {
  const id = groupId(group.key);
  const key = editorKey(viewKind, subject?.id ?? null, id);
  const adding = useList((s) => s.editorGroup === key);
  const openEditor = useList((s) => s.openEditor);
  const place = groupPlace(group.key, viewKind, subject?.id ?? null);
  const agent = useDefaultAgent();
  const title = groupTitle(group.key, new Date(), agent);
  const mixed = viewKind === "all";
  // The date the header already shows: the rows do not repeat it.
  const shownDate =
    group.key.type === "day"
      ? group.key.date
      : viewKind === "today"
        ? todayString()
        : undefined;
  // « Prochainement »: a day receives the tasks dragged from another day (2026-10-12).
  const dayDate = group.key.type === "day" ? group.key.date : undefined;
  const data: DragData | undefined = place
    ? { type: "group", groupId: id, place, reorderable: true }
    : dayDate
      ? {
          type: "group",
          groupId: id,
          place: { subjectId: null, sectionId: null },
          reorderable: false,
          date: dayDate,
        }
      : undefined;
  const drop = useDroppable({
    id: dragId.group(id),
    data,
    disabled:
      data === undefined || !(features.dragAndDrop || features.touchDrag),
  });
  // « À faire »: the group is sortable among the groups of its level, and receives the tasks
  // dropped on its area (`project_group` covers it: the `group` droppable is off there).
  const groupDrag = mixed ? projectGroupDrag(group) : null;
  const sortable = useSortable({
    id: dragId.projectGroup(id),
    data: groupDrag ?? undefined,
    // An object, not a boolean: dnd-kit reads `true` as "not draggable but still droppable",
    // which would light up the groups of Today and Upcoming under a dragged task.
    disabled:
      groupDrag === null || !(features.dragAndDrop || features.touchDrag)
        ? { draggable: true, droppable: true }
        : false,
  });
  const setDropRef = drop.setNodeRef;
  const setSortRef = sortable.setNodeRef;
  const setNodeRef = useCallback(
    (el: HTMLElement | null) => {
      setDropRef(el);
      setSortRef(el);
    },
    [setDropRef, setSortRef],
  );
  const dragged = sortable.active?.data.current as DragData | undefined;
  // A task held over another group's area: it lands at the end of that project.
  const taskOverGroup =
    sortable.isOver && dragged?.type === "task" && dragged.groupId !== id;
  // The core decides which groups get a header.
  const showHeader = group.showHeader && title !== null;
  const size = group.tasks.length;
  // « À faire » groups by project: the rows never repeat it.
  const rows = mixed
    ? group.tasks.map((t) => (t.subject ? { ...t, subject: null } : t))
    : group.tasks;
  const dragHandle: DragHandle | undefined =
    groupDrag !== null && (features.dragAndDrop || features.touchDrag)
      ? { ref: sortable.setActivatorNodeRef, listeners: sortable.listeners }
      : undefined;

  // « Prochainement »: a day without task is one line (2026-10-12), until its « + » opens
  // the editor. It still receives a task dragged onto it.
  if (group.key.type === "day" && size === 0 && !adding && title) {
    return (
      <section
        ref={setNodeRef}
        aria-label={title}
        data-group={id}
        data-empty-day
        className={`mt-1 scroll-mt-4 rounded-lg ${drop.isOver ? "bg-selected" : ""}`}
      >
        <div className="flex h-10 items-center gap-3 border-b border-border-row px-2">
          <h2 className="min-w-0 shrink-0 truncate text-[13px] font-semibold text-text-2 sm:w-[150px]">
            {title}
          </h2>
          <span className="flex-1 truncate text-[13px] text-text-3">
            {fr.upcoming.nothingPlanned}
          </span>
          {group.addTarget && (
            <button
              type="button"
              aria-label={fr.upcoming.addOnDay(title)}
              title={fr.upcoming.addOnDay(title)}
              onClick={() => openEditor(key)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
            >
              <Plus size={15} aria-hidden />
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      aria-label={title ?? undefined}
      data-group={id}
      style={
        groupDrag
          ? {
              transform: CSS.Translate.toString(sortable.transform),
              transition: sortable.transition,
            }
          : undefined
      }
      className={`scroll-mt-4 rounded-lg ${showHeader ? "mt-6" : ""} ${
        (drop.isOver && (size === 0 || dayDate !== undefined)) || taskOverGroup
          ? "bg-selected"
          : ""
      } ${sortable.isDragging ? "relative z-10 opacity-60" : ""}`}
    >
      {showHeader && title && (
        <GroupHeader group={group} title={title} dragHandle={dragHandle} />
      )}
      <SortableContext
        items={group.tasks.map((t) => dragId.task(t.id))}
        strategy={verticalListSortingStrategy}
      >
        <ul data-task-list className="flex flex-col">
          {rows.map((row, index) => (
            <li key={row.id}>
              <SortableTaskRow
                row={row}
                index={index}
                size={size}
                groupId={id}
                place={place}
                viewKind={viewKind}
                shownDate={shownDate}
                mixed={mixed}
                groupRows={group.tasks}
              />
            </li>
          ))}
        </ul>
      </SortableContext>
      {group.addTarget && (
        // Pointed at by the first-launch guide (« Une tâche »).
        <div data-tutorial="add-task">
          {adding ? (
            <TaskEditor
              key={key}
              target={group.addTarget}
              // A day of « Prochainement » prefills its date.
              dueDate={
                group.addTarget.dueDate ??
                (group.key.type === "day" ? group.key.date : undefined)
              }
              onClose={() => openEditor(null)}
            />
          ) : (
            <AddTaskRow onClick={() => openEditor(key)} />
          )}
        </div>
      )}
    </section>
  );
}

/** Collapsed « Terminées » fold; its state is a setting (`showCompleted`), kept by the parent. */
export function CompletedGroup({
  rows,
  expanded,
  onToggle,
}: {
  rows: TaskRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (rows.length === 0) return null;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <section aria-label={fr.views.completed} className="mt-8">
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-text-2 hover:text-text"
        >
          <Chevron size={15} aria-hidden />
          {fr.views.completed}
          <span className="font-normal tabular-nums">{rows.length}</span>
        </button>
      </h2>
      {expanded && (
        <ul data-task-list className="flex flex-col">
          {rows.map((row) => (
            <li key={row.id}>
              <ConnectedTaskRow row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
