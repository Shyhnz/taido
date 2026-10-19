import type { Agent, GroupKey, TaskGroup, ViewKind } from "../../bindings";
import { fr } from "../../i18n/fr";
import type { DragData, Place } from "../dnd/DndProvider";
import { dayTitle } from "./upcomingModel";

/** Stable id of a group within a view. */
export function groupId(key: GroupKey): string {
  if (key.type === "section") return `section:${key.id}`;
  if (key.type === "day") return `day:${key.date}`;
  if (key.type === "project") return `project:${key.id}`;
  return key.type;
}

/**
 * French title of a group, or `null` when the group has no header: tasks outside
 * any section, the single list of « Sans projet » and the plain tasks of Today have none.
 * « Sans section » is never shown.
 */
export function groupTitle(
  key: GroupKey,
  now: Date = new Date(),
  agent: Agent = "claude",
): string | null {
  switch (key.type) {
    case "section":
      return key.name;
    case "day":
      return dayTitle(key.date, now);
    case "today_waiting":
      return fr.views.groups.claudeWaiting(agent);
    case "today_overdue":
      return fr.views.groups.overdue;
    case "today_rest":
      return fr.views.groups.today;
    // « À faire »: « Globex › Client » for a sub-project.
    case "project":
      return key.parent_name
        ? fr.subProjects.path(key.parent_name, key.name)
        : key.name;
    case "no_project":
      return fr.sidebar.noProject;
    default:
      return null;
  }
}

/**
 * The place a group stands for, when its rows can be reordered or receive drops
 * (« Sans projet » and project views). `null` for computed groups (Today) and for the groups
 * of « À faire », whose rows each carry their own place.
 */
export function groupPlace(
  key: GroupKey,
  viewKind: ViewKind,
  subjectId: string | null,
): Place | null {
  if (viewKind === "inbox" && key.type === "inbox") {
    return { subjectId: null, sectionId: null };
  }
  if (viewKind === "subject" && subjectId) {
    if (key.type === "no_section") return { subjectId, sectionId: null };
    if (key.type === "section") return { subjectId, sectionId: key.id };
  }
  return null;
}

/**
 * Drag data of a « À faire » group, dragged by its header to reorder projects (« Sans
 * projet » included). `null` for any other group: only « À faire » groups carry an `order`.
 */
export function projectGroupDrag(group: TaskGroup): DragData | null {
  const { key, order } = group;
  if (!order || (key.type !== "project" && key.type !== "no_project")) {
    return null;
  }
  const subjectId = key.type === "project" ? key.id : null;
  return {
    type: "project_group",
    subjectId,
    name: groupTitle(key) ?? "",
    index: order.index,
    parentId: order.parentId,
    groupId: groupId(key),
    place: { subjectId, sectionId: null },
  };
}
