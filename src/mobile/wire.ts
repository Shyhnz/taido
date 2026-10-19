/**
 * Records of the mock state ↔ wire data of the sync protocol (src/lib/sync-proto.ts). Only
 * synced columns travel; local-only ones (`rootPath`, `subpath`, `workdirOverride`) are never
 * read nor written here, and a new record gets them `null` (docs/SYNC.md § 2.5).
 *
 * Protocol 3 (Taido V2.7): a project's `is_group` and a task's `board_column_id` are kept in
 * the state and sent back as they came. The four new entities are held too: attachments since
 * V2.7 bis (`MockLinks.attachments`); Kanban columns (`MockBoard.columns`), time segments
 * (`MockChrono.segments`, `agent_session_id` stays local) and relations (`MockLinks.relations`)
 * since V2.8. The project notebook adds `note_group` and
 * `note_page` (`MockNotes.groups`, `.pages`) and `note_attachment`, a page's image, which lives
 * in `MockLinks.attachments` with its page as owner (`notePageId`). A row of an entity this
 * build does not know is ignored (`isShownChange`).
 */

import type { SubjectColor } from "../bindings";
import type {
  MockState,
  SectionRec,
  SubjectRec,
  TaskRec,
} from "../lib/mock-backend";
import type { ColumnRec } from "../lib/mock-board";
import type { SegmentRec } from "../lib/mock-chrono";
import type { AttachmentRec, RelationRec } from "../lib/mock-links";
import type { NoteGroupRec, NotePageRec } from "../lib/mock-notes";
import {
  type AttachmentChange,
  type AttachmentData,
  type BoardColumnChange,
  type BoardColumnData,
  type Change,
  changeKey,
  EPOCH_STAMP,
  isSha256Hex,
  type NoteAttachmentChange,
  type NoteAttachmentData,
  type NoteGroupChange,
  type NoteGroupData,
  type NotePageChange,
  type NotePageData,
  type RelationChange,
  type RelationData,
  type SectionChange,
  type SectionData,
  type SettingChange,
  type SettingData,
  type SubjectChange,
  type SubjectData,
  type TaskChange,
  type TaskData,
  type TimeSegmentChange,
  type TimeSegmentData,
} from "../lib/sync-proto";

/** Entities the phone holds and syncs (all of protocol 3 since V2.8). */
export type ShownEntity =
  | "subject"
  | "section"
  | "task"
  | "setting"
  | "board_column"
  | "time_segment"
  | "relation"
  | "attachment"
  | "note_group"
  | "note_page"
  | "note_attachment";
export type ShownChange =
  | SubjectChange
  | SectionChange
  | TaskChange
  | SettingChange
  | BoardColumnChange
  | TimeSegmentChange
  | RelationChange
  | AttachmentChange
  | NoteGroupChange
  | NotePageChange
  | NoteAttachmentChange;

const SHOWN: ReadonlySet<string> = new Set<ShownEntity>([
  "subject",
  "section",
  "task",
  "setting",
  "board_column",
  "time_segment",
  "relation",
  "attachment",
  "note_group",
  "note_page",
  "note_attachment",
]);

/**
 * Whether the phone applies this row. A row of an entity this build does not know (a later
 * protocol's) is ignored: never parked, applied nor queued back.
 */
export const isShownChange = (c: Change): c is ShownChange =>
  SHOWN.has(c.entity);

/** The synced records the phone keeps outside `MockState` (the mock's helpers own them). */
export interface SyncedRecs {
  /** Task attachments and page images (`notePageId` set). */
  attachments: AttachmentRec[];
  noteGroups: NoteGroupRec[];
  notePages: NotePageRec[];
  boardColumns: ColumnRec[];
  timeSegments: SegmentRec[];
  relations: RelationRec[];
}

/** Exhaustiveness guard of a `switch` over a union: a new member fails to compile. */
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}

export const subjectToWire = (s: SubjectRec): SubjectData => ({
  name: s.name,
  color: s.color,
  parent_id: s.parentId,
  position: s.position,
  created_at: s.createdAt,
  deleted_at: s.deletedAt,
  is_group: s.isGroup ?? false,
});

export const sectionToWire = (s: SectionRec): SectionData => ({
  subject_id: s.subjectId,
  name: s.name,
  position: s.position,
  created_at: s.createdAt,
});

export const taskToWire = (t: TaskRec): TaskData => ({
  subject_id: t.subjectId,
  section_id: t.sectionId,
  parent_id: t.parentId,
  title: t.title,
  description: t.description,
  due_date: t.dueDate,
  due_time: t.dueTime,
  priority: t.priority,
  completed_at: t.completedAt,
  position: t.position,
  created_at: t.createdAt,
  deleted_at: t.deletedAt,
  board_column_id: t.boardColumnId ?? null,
});

export const settingToWire = (value: unknown): SettingData => ({ value });

/**
 * Same fields and order as the server's JSON; `sha256` is left out when unknown (never
 * `null`), as Rust serialises it, so the snapshot matches what comes back.
 */
export const attachmentToWire = (a: AttachmentRec): AttachmentData => ({
  task_id: a.taskId,
  file_name: a.fileName,
  mime_type: a.mimeType,
  size: a.size,
  ...(a.sha256 !== undefined ? { sha256: a.sha256 } : {}),
  created_at: a.addedAt,
  deleted_at: a.deletedAt,
});

/** Same fields and order as `NoteAttachmentData`; `sha256` is left out when unknown. */
export const noteAttachmentToWire = (a: AttachmentRec): NoteAttachmentData => ({
  note_page_id: a.notePageId ?? "",
  file_name: a.fileName,
  mime_type: a.mimeType,
  size: a.size,
  ...(a.sha256 !== undefined ? { sha256: a.sha256 } : {}),
  created_at: a.addedAt,
  deleted_at: a.deletedAt,
});

/** Same fields and order as the Rust struct (`NoteGroupData`). */
export const noteGroupToWire = (g: NoteGroupRec): NoteGroupData => ({
  subject_id: g.subjectId,
  name: g.name,
  position: g.position,
  created_at: g.createdAt,
});

/** Same fields and order as the Rust struct (`NotePageData`). */
export const notePageToWire = (p: NotePageRec): NotePageData => ({
  subject_id: p.subjectId,
  group_id: p.groupId,
  kind: p.kind,
  title: p.title,
  body: p.body,
  source_task_id: p.sourceTaskId,
  pinned_at: p.pinnedAt,
  position: p.position,
  created_at: p.createdAt,
  deleted_at: p.deletedAt,
});

/** Same fields and order as the Rust struct (`BoardColumnData`). */
export const columnToWire = (c: ColumnRec): BoardColumnData => ({
  subject_id: c.subjectId,
  name: c.name,
  position: c.position,
  is_done: c.isDone,
  created_at: c.createdAt ?? EPOCH_STAMP,
});

/** Same fields and order as the Rust struct; `agent_session_id` never travels. */
export const segmentToWire = (s: SegmentRec): TimeSegmentData => ({
  task_id: s.taskId,
  source: s.source,
  started_at: s.startedAt,
  ended_at: s.endedAt,
  stop_reason: s.stopReason,
  note: s.note,
  created_at: s.createdAt ?? s.startedAt,
  deleted_at: s.deletedAt,
});

/** Same fields and order as the Rust struct (`RelationData`). */
export const relationToWire = (r: RelationRec): RelationData => ({
  from_task_id: r.from,
  to_task_id: r.to,
  kind: r.kind,
  created_at: r.createdAt,
  deleted_at: r.deletedAt,
});

/** An image to show with the image icon (the tile; opening decides from the bytes). */
export const isImageMime = (mime: string): boolean =>
  mime.toLowerCase().startsWith("image/");

/** Whether the state holds the shared setting `key` (own key only). */
export const hasSetting = (state: MockState, key: string): boolean =>
  Object.hasOwn(state.syncedSettings, key);

/** One row of the state with its wire data, keyed `entity:id`. */
export interface WireRow {
  entity: ShownEntity;
  id: string;
  json: string;
}

/** Every synced row of the state (soft-deleted ones included), by key. */
export function wireRows(
  state: MockState,
  recs: SyncedRecs,
): Map<string, WireRow> {
  const rows = new Map<string, WireRow>();
  const add = (entity: ShownEntity, id: string, data: unknown) =>
    rows.set(changeKey({ entity, id }), {
      entity,
      id,
      json: JSON.stringify(data),
    });
  for (const s of state.subjects) add("subject", s.id, subjectToWire(s));
  for (const s of state.sections) add("section", s.id, sectionToWire(s));
  for (const t of state.tasks) add("task", t.id, taskToWire(t));
  for (const [k, value] of Object.entries(state.syncedSettings)) {
    add("setting", k, settingToWire(value));
  }
  for (const c of recs.boardColumns) {
    add("board_column", c.id, columnToWire(c));
  }
  for (const x of recs.timeSegments) {
    add("time_segment", x.id, segmentToWire(x));
  }
  for (const r of recs.relations) add("relation", r.id, relationToWire(r));
  for (const a of recs.attachments) {
    if (a.notePageId === undefined)
      add("attachment", a.id, attachmentToWire(a));
    else add("note_attachment", a.id, noteAttachmentToWire(a));
  }
  for (const g of recs.noteGroups) add("note_group", g.id, noteGroupToWire(g));
  for (const p of recs.notePages) add("note_page", p.id, notePageToWire(p));
  return rows;
}

/** Wire JSON of one record of the state, or `null` when it does not exist. */
export function wireJsonOf(
  state: MockState,
  recs: SyncedRecs,
  entity: ShownEntity,
  id: string,
): string | null {
  switch (entity) {
    case "subject": {
      const s = state.subjects.find((x) => x.id === id);
      return s ? JSON.stringify(subjectToWire(s)) : null;
    }
    case "section": {
      const s = state.sections.find((x) => x.id === id);
      return s ? JSON.stringify(sectionToWire(s)) : null;
    }
    case "task": {
      const t = state.tasks.find((x) => x.id === id);
      return t ? JSON.stringify(taskToWire(t)) : null;
    }
    case "setting":
      return hasSetting(state, id)
        ? JSON.stringify(settingToWire(state.syncedSettings[id]))
        : null;
    case "board_column": {
      const c = recs.boardColumns.find((x) => x.id === id);
      return c ? JSON.stringify(columnToWire(c)) : null;
    }
    case "time_segment": {
      const x = recs.timeSegments.find((y) => y.id === id);
      return x ? JSON.stringify(segmentToWire(x)) : null;
    }
    case "relation": {
      const r = recs.relations.find((x) => x.id === id);
      return r ? JSON.stringify(relationToWire(r)) : null;
    }
    case "attachment": {
      const a = recs.attachments.find(
        (x) => x.id === id && x.notePageId === undefined,
      );
      return a ? JSON.stringify(attachmentToWire(a)) : null;
    }
    case "note_attachment": {
      const a = recs.attachments.find(
        (x) => x.id === id && x.notePageId !== undefined,
      );
      return a ? JSON.stringify(noteAttachmentToWire(a)) : null;
    }
    case "note_group": {
      const g = recs.noteGroups.find((x) => x.id === id);
      return g ? JSON.stringify(noteGroupToWire(g)) : null;
    }
    case "note_page": {
      const p = recs.notePages.find((x) => x.id === id);
      return p ? JSON.stringify(notePageToWire(p)) : null;
    }
    default:
      return assertNever(entity);
  }
}

/** Writes a pulled shared setting (a setting is never deleted). */
export function upsertSetting(
  state: MockState,
  key: string,
  d: SettingData,
): void {
  state.syncedSettings[key] = d.value;
}

/** Writes a pulled subject: synced columns only (UPSERT, never a replace). */
export function upsertSubject(
  state: MockState,
  id: string,
  d: SubjectData,
  stamp: string,
): SubjectRec {
  const existing = state.subjects.find((s) => s.id === id);
  const rec: SubjectRec = existing ?? {
    id,
    name: d.name,
    color: d.color as SubjectColor,
    rootPath: null,
    parentId: null,
    position: d.position,
    createdAt: d.created_at,
    updatedAt: stamp,
    deletedAt: null,
  };
  rec.name = d.name;
  rec.color = d.color as SubjectColor;
  rec.parentId = d.parent_id;
  rec.position = d.position;
  rec.createdAt = d.created_at;
  rec.deletedAt = d.deleted_at;
  // Absent before protocol 3: a project.
  rec.isGroup = d.is_group === true;
  rec.updatedAt = stamp;
  if (!existing) state.subjects.push(rec);
  return rec;
}

export function upsertSection(
  state: MockState,
  id: string,
  d: SectionData,
  stamp: string,
): SectionRec {
  const existing = state.sections.find((s) => s.id === id);
  const rec: SectionRec = existing ?? {
    id,
    subjectId: d.subject_id,
    name: d.name,
    subpath: null,
    position: d.position,
    createdAt: d.created_at,
    updatedAt: stamp,
  };
  rec.subjectId = d.subject_id;
  rec.name = d.name;
  rec.position = d.position;
  rec.createdAt = d.created_at;
  rec.updatedAt = stamp;
  if (!existing) state.sections.push(rec);
  return rec;
}

export function upsertTask(
  state: MockState,
  id: string,
  d: TaskData,
  stamp: string,
): TaskRec {
  const existing = state.tasks.find((t) => t.id === id);
  const rec: TaskRec = existing ?? {
    id,
    parentId: null,
    priority: 1,
    subjectId: null,
    sectionId: null,
    title: d.title,
    description: "",
    dueDate: null,
    dueTime: null,
    workdirOverride: null,
    completedAt: null,
    position: d.position,
    createdAt: d.created_at,
    updatedAt: stamp,
    deletedAt: null,
  };
  rec.subjectId = d.subject_id;
  rec.sectionId = d.section_id;
  rec.parentId = d.parent_id;
  rec.title = d.title;
  rec.description = d.description;
  rec.dueDate = d.due_date;
  rec.dueTime = d.due_time;
  rec.priority = d.priority;
  rec.completedAt = d.completed_at;
  rec.position = d.position;
  rec.createdAt = d.created_at;
  rec.deletedAt = d.deleted_at;
  // Absent before protocol 3: no column.
  rec.boardColumnId = d.board_column_id ?? null;
  rec.updatedAt = stamp;
  if (!existing) state.tasks.push(rec);
  return rec;
}

/**
 * Writes a pulled attachment: synced columns only (UPSERT). A new one is `missing` here (on
 * the server or another device: opened on demand). The pulled `sha256` replaces the known one
 * only when set (a version without it, from an older app, keeps it); a different one means the
 * copy kept here is not this file any more: `missing`, the copy is dropped by the next sweep
 * (content never changes once hashed).
 */
export function upsertAttachment(
  attachments: AttachmentRec[],
  id: string,
  d: AttachmentData,
): AttachmentRec {
  return upsertFile(attachments, id, { ...d, owner: { taskId: d.task_id } });
}

/** Writes a pulled page image, like `upsertAttachment` (the page is its owner). */
export function upsertNoteAttachment(
  attachments: AttachmentRec[],
  id: string,
  d: NoteAttachmentData,
): AttachmentRec {
  return upsertFile(attachments, id, {
    ...d,
    owner: { notePageId: d.note_page_id },
  });
}

function upsertFile(
  attachments: AttachmentRec[],
  id: string,
  d: Omit<AttachmentData, "task_id"> & {
    owner: { taskId: string } | { notePageId: string };
  },
): AttachmentRec {
  const taskId = "taskId" in d.owner ? d.owner.taskId : "";
  const notePageId = "notePageId" in d.owner ? d.owner.notePageId : undefined;
  const existing = attachments.find((a) => a.id === id);
  const rec: AttachmentRec = existing ?? {
    id,
    taskId,
    ...(notePageId !== undefined ? { notePageId } : {}),
    fileName: d.file_name,
    path: d.file_name,
    mimeType: d.mime_type,
    isImage: false,
    size: d.size,
    addedAt: d.created_at,
    exists: true,
    remote: "none",
    dataUrl: null,
    deletedAt: null,
    file: "missing",
  };
  const pulled =
    typeof d.sha256 === "string" && isSha256Hex(d.sha256)
      ? d.sha256
      : undefined;
  if (pulled !== undefined) {
    if (rec.sha256 !== undefined && rec.sha256 !== pulled) rec.file = "missing";
    rec.sha256 = pulled;
  }
  rec.taskId = taskId;
  if (notePageId !== undefined) rec.notePageId = notePageId;
  rec.fileName = d.file_name;
  rec.path = d.file_name;
  rec.mimeType = d.mime_type;
  rec.isImage = isImageMime(d.mime_type);
  rec.size = d.size;
  rec.addedAt = d.created_at;
  rec.deletedAt = d.deleted_at;
  if (!existing) attachments.push(rec);
  return rec;
}

/** Writes a pulled notebook group: synced columns only (UPSERT). */
export function upsertNoteGroup(
  groups: NoteGroupRec[],
  id: string,
  d: NoteGroupData,
  stamp: string,
): NoteGroupRec {
  const existing = groups.find((g) => g.id === id);
  const rec: NoteGroupRec = existing ?? {
    id,
    subjectId: d.subject_id,
    name: d.name,
    position: d.position,
    createdAt: d.created_at,
    updatedAt: stamp,
  };
  rec.subjectId = d.subject_id;
  rec.name = d.name;
  rec.position = d.position;
  rec.createdAt = d.created_at;
  rec.updatedAt = stamp;
  if (!existing) groups.push(rec);
  return rec;
}

/** Writes a pulled notebook page: synced columns only (UPSERT). */
export function upsertNotePage(
  pages: NotePageRec[],
  id: string,
  d: NotePageData,
  stamp: string,
): NotePageRec {
  const existing = pages.find((p) => p.id === id);
  const rec: NotePageRec = existing ?? {
    id,
    subjectId: d.subject_id,
    groupId: d.group_id,
    kind: d.kind,
    title: d.title,
    body: d.body,
    sourceTaskId: d.source_task_id,
    pinnedAt: d.pinned_at,
    position: d.position,
    createdAt: d.created_at,
    updatedAt: stamp,
    deletedAt: d.deleted_at,
  };
  rec.subjectId = d.subject_id;
  rec.groupId = d.group_id;
  rec.kind = d.kind;
  rec.title = d.title;
  rec.body = d.body;
  rec.sourceTaskId = d.source_task_id;
  rec.pinnedAt = d.pinned_at;
  rec.position = d.position;
  rec.createdAt = d.created_at;
  rec.deletedAt = d.deleted_at;
  rec.updatedAt = stamp;
  if (!existing) pages.push(rec);
  return rec;
}

/** Writes a pulled Kanban column: synced columns only (UPSERT). */
export function upsertColumn(
  columns: ColumnRec[],
  id: string,
  d: BoardColumnData,
): ColumnRec {
  const existing = columns.find((c) => c.id === id);
  const rec: ColumnRec = existing ?? {
    id,
    subjectId: d.subject_id,
    name: d.name,
    position: d.position,
    isDone: d.is_done,
  };
  rec.subjectId = d.subject_id;
  rec.name = d.name;
  rec.position = d.position;
  rec.isDone = d.is_done;
  rec.createdAt = d.created_at;
  if (!existing) columns.push(rec);
  return rec;
}

/**
 * Writes a pulled time segment: synced columns only (UPSERT). Its session stays this device's
 * (`agentSessionId`, never synced): `null` for a new row, so a running segment pulled from a
 * Mac is never stopped here (docs/SYNC.md § 0.8).
 */
export function upsertSegment(
  segments: SegmentRec[],
  id: string,
  d: TimeSegmentData,
): SegmentRec {
  const existing = segments.find((x) => x.id === id);
  const rec: SegmentRec = existing ?? {
    id,
    taskId: d.task_id,
    agentSessionId: null,
    source: d.source,
    startedAt: d.started_at,
    endedAt: d.ended_at,
    stopReason: d.stop_reason,
    note: d.note,
    deletedAt: null,
  };
  rec.taskId = d.task_id;
  rec.source = d.source;
  rec.startedAt = d.started_at;
  rec.endedAt = d.ended_at;
  rec.stopReason = d.stop_reason;
  rec.note = d.note;
  rec.createdAt = d.created_at;
  rec.deletedAt = d.deleted_at;
  if (!existing) segments.push(rec);
  return rec;
}

/** Writes a pulled task relation: synced columns only (UPSERT). */
export function upsertRelation(
  relations: RelationRec[],
  id: string,
  d: RelationData,
): RelationRec {
  const existing = relations.find((r) => r.id === id);
  const rec: RelationRec = existing ?? {
    id,
    from: d.from_task_id,
    to: d.to_task_id,
    kind: d.kind,
    createdAt: d.created_at,
    deletedAt: null,
  };
  rec.from = d.from_task_id;
  rec.to = d.to_task_id;
  rec.kind = d.kind;
  rec.createdAt = d.created_at;
  rec.deletedAt = d.deleted_at;
  if (!existing) relations.push(rec);
  return rec;
}
