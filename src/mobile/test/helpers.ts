/** Builders shared by the phone's tests. */

import type {
  AttachmentData,
  BoardColumnData,
  Change,
  NoteAttachmentData,
  NoteGroupData,
  NotePageData,
  RelationData,
  TaskData,
  TimeSegmentData,
} from "../../lib/sync-proto";
import { MobileBackend } from "../backend";
import { type FileStore, MemoryFileStore } from "../files";
import type { Persisted } from "../persisted";
import { MemoryStore } from "../store";
import { FakeServer } from "./fakeServer";

export const SERVER_URL = "https://todo.test";

/** A clock tests move by hand. */
export class Clock {
  t = Date.parse("2026-10-04T10:00:00.000Z");
  now = () => new Date(this.t);
  iso = () => new Date(this.t).toISOString();
  advance(ms: number) {
    this.t += ms;
  }
}

export interface Phone {
  backend: MobileBackend;
  store: MemoryStore;
  /** The attachment files kept on the phone (IndexedDB `todo-files` in the app). */
  files: FileStore;
  clock: Clock;
  server: FakeServer;
}

export function makePhone(
  server = new FakeServer(),
  options: {
    persisted?: Persisted | null;
    clock?: Clock;
    files?: FileStore;
    /** Upload chunk size (tests use a few bytes instead of 8 MiB). */
    chunkBytes?: number;
  } = {},
): Phone {
  const store = new MemoryStore();
  const clock = options.clock ?? new Clock();
  const files = options.files ?? new MemoryFileStore();
  const backend = new MobileBackend({
    store,
    persisted: options.persisted ?? null,
    now: clock.now,
    fetch: server.fetch,
    fileStore: files,
    ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
  });
  return { backend, store, files, clock, server };
}

/** Links and waits for the first run. */
export async function link(phone: Phone): Promise<void> {
  await phone.backend.commands.syncLogin({
    serverUrl: SERVER_URL,
    email: "user@exemple.fr",
    password: phone.server.password,
  });
  await phone.backend.engine.syncNow();
}

export const task = (
  id: string,
  stamp: string,
  patch: Partial<TaskData> = {},
): Change => ({
  entity: "task",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    subject_id: null,
    section_id: null,
    parent_id: null,
    title: id,
    description: "",
    due_date: null,
    due_time: null,
    priority: 1,
    completed_at: null,
    position: 1,
    created_at: stamp,
    deleted_at: null,
    board_column_id: null,
    ...patch,
  },
});

export const subject = (
  id: string,
  stamp: string,
  patch: Partial<{
    parent_id: string | null;
    deleted_at: string | null;
    name: string;
    is_group: boolean;
  }> = {},
): Change => ({
  entity: "subject",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    name: id,
    color: "teal",
    parent_id: null,
    position: 1,
    created_at: stamp,
    deleted_at: null,
    is_group: false,
    ...patch,
  },
});

export const section = (
  id: string,
  subjectId: string,
  stamp: string,
): Change => ({
  entity: "section",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: { subject_id: subjectId, name: id, position: 1, created_at: stamp },
});

export const tombstone = (
  entity: Change["entity"],
  id: string,
  stamp: string,
) =>
  ({ entity, id, updated_at: stamp, device_id: "mac", data: null }) as Change;

export const setting = (key: string, stamp: string, value: unknown): Change =>
  ({
    entity: "setting",
    id: key,
    updated_at: stamp,
    device_id: "mac",
    data: { value },
  }) as Change;

/** A Kanban column (protocol 3, held by the phone). */
export const boardColumn = (
  id: string,
  subjectId: string | null,
  stamp: string,
  patch: Partial<BoardColumnData> = {},
): Change => ({
  entity: "board_column",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    subject_id: subjectId,
    name: id,
    position: 0,
    is_done: false,
    created_at: stamp,
    ...patch,
  },
});

/** A time segment of the chrono (protocol 3, held by the phone); running by default. */
export const timeSegment = (
  id: string,
  taskId: string,
  stamp: string,
  patch: Partial<TimeSegmentData> = {},
): Change => ({
  entity: "time_segment",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    task_id: taskId,
    source: "auto",
    started_at: stamp,
    ended_at: null,
    stop_reason: null,
    note: "",
    created_at: stamp,
    deleted_at: null,
    ...patch,
  },
});

/** A task relation (protocol 3, held by the phone); `blocks` by default. */
export const relation = (
  id: string,
  from: string,
  to: string,
  stamp: string,
  patch: Partial<RelationData> = {},
): Change => ({
  entity: "relation",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    from_task_id: from,
    to_task_id: to,
    kind: "blocks",
    created_at: stamp,
    deleted_at: null,
    ...patch,
  },
});

/** An attachment row (protocol 3; its file travels apart). */
export const attachment = (
  id: string,
  taskId: string,
  stamp: string,
  patch: Partial<AttachmentData> = {},
): Change => ({
  entity: "attachment",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    task_id: taskId,
    file_name: `${id}.pdf`,
    mime_type: "application/pdf",
    size: 3,
    created_at: stamp,
    deleted_at: null,
    ...patch,
  },
});

/** A notebook group. */
export const noteGroup = (
  id: string,
  subjectId: string,
  stamp: string,
  patch: Partial<NoteGroupData> = {},
): Change => ({
  entity: "note_group",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    subject_id: subjectId,
    name: id,
    position: 1,
    created_at: stamp,
    ...patch,
  },
});

/** A notebook page: a plain page outside any group by default. */
export const notePage = (
  id: string,
  subjectId: string,
  stamp: string,
  patch: Partial<NotePageData> = {},
): Change => ({
  entity: "note_page",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    subject_id: subjectId,
    group_id: null,
    kind: "page",
    title: id,
    body: "",
    source_task_id: null,
    pinned_at: null,
    position: 1,
    created_at: stamp,
    deleted_at: null,
    ...patch,
  },
});

/** An image of a notebook page (its file travels apart, like an attachment's). */
export const noteAttachment = (
  id: string,
  pageId: string,
  stamp: string,
  patch: Partial<NoteAttachmentData> = {},
): Change => ({
  entity: "note_attachment",
  id,
  updated_at: stamp,
  device_id: "mac",
  data: {
    note_page_id: pageId,
    file_name: `${id}.png`,
    mime_type: "image/png",
    size: 3,
    created_at: stamp,
    deleted_at: null,
    ...patch,
  },
});
