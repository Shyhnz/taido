/**
 * Wire types of the Todo sync protocol, hand-written mirror of the Rust crate
 * `crates/sync-proto` (src/lib.rs). Keep both in step: the golden fixtures
 * `crates/sync-proto/fixtures/*.json` are checked by the Rust tests and by
 * `sync-proto.test.ts`. Full contract: docs/SYNC.md.
 *
 * JSON is snake_case (unlike src/bindings.ts). `updated_at` is a canonical UTC instant
 * `YYYY-MM-DDTHH:MM:SS.sssZ` (what `Date.prototype.toISOString` gives), so comparing the
 * strings compares the instants.
 */

export const PROTOCOL_VERSION = 3;
export const MAX_SYNC_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_ID_LEN = 128;
export const MAX_STAMP_LEN = 64;
/** Clients push at most this many changes per request, looping until the outbox is sent. */
export const MAX_PUSH_CHANGES = 500;
/** …and at most this many bytes of serialized changes (a larger single change goes alone). */
export const MAX_PUSH_BYTES = 4 * 1024 * 1024;
/** The server returns at most this many pulled rows per response (`has_more`). */
export const MAX_PULL_CHANGES = 2000;
/** …and stops a page once its rows' data pass this many bytes (a larger row comes alone). */
export const MAX_PULL_BYTES = 8 * 1024 * 1024;
/**
 * Lowest conflict stamp: a row enqueued without any known version (first link, server
 * reset) carries it; accepted when the server lacks the row, loses to any real version.
 */
export const EPOCH_STAMP = "1970-01-01T00:00:00.000Z";
/** Longest setting key; keys are `[a-z0-9_]`, 1 to 64 bytes. */
export const MAX_SETTING_KEY_LEN = 64;
/** Largest serialized `SettingData.value` (JSON bytes). */
export const MAX_SETTING_VALUE_BYTES = 4096;
/** Position of « Sans projet » among the top-level projects (a JSON number). */
export const SETTING_INBOX_POSITION = "inbox_position";
/** Shared theme (`{ theme, color }`), see `SETTING_APPEARANCE` in crates/sync-proto. */
export const SETTING_APPEARANCE = "appearance";

/** Longest attachment file name (bytes). */
export const MAX_FILE_NAME_BYTES = 255;
/** Largest body of one file upload request (8 MiB); chunks follow each other at `offset`. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Default largest attachment file (100 MiB); the server can change it. */
export const DEFAULT_MAX_FILE_BYTES = 104_857_600;
/** Default total size of the files of one account (2 GiB); the server can change it. */
export const DEFAULT_ACCOUNT_QUOTA_BYTES = 2_147_483_648;
/** Largest notebook page body (Markdown), in bytes (256 KiB). */
export const MAX_NOTE_BODY_BYTES = 262_144;
/** Longest notebook page title, in bytes (not blank). */
export const MAX_NOTE_TITLE_BYTES = 500;
/** Accepted `NotePageData.kind` values: a plain page, or a task's end summary. */
export const NOTE_KINDS = ["page", "summary"] as const;
/** Accepted `TimeSegmentData.stop_reason` values. */
export const STOP_REASONS = [
  "waiting",
  "turn_ended",
  "session_closed",
  "task_done",
  "app_closed",
] as const;

export type Entity =
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

/** The entities every protocol 3 client reads; a request without `known_entities` gets only these. */
export const LEGACY_ENTITIES = [
  "subject",
  "section",
  "task",
  "setting",
  "board_column",
  "time_segment",
  "relation",
  "attachment",
] as const satisfies readonly Entity[];

/** Every entity of this version, the legacy ones first (`Entity::ALL` in Rust). */
export const ALL_ENTITIES = [
  ...LEGACY_ENTITIES,
  "note_group",
  "note_page",
  "note_attachment",
] as const satisfies readonly Entity[];

/**
 * What the server sends a client that declared `known` (`known_entity_set` in Rust): the
 * legacy entities plus the listed names this version knows.
 */
export function knownEntitySet(known: readonly string[] | undefined): Entity[] {
  const out: Entity[] = [...LEGACY_ENTITIES];
  for (const name of known ?? []) {
    const e = ALL_ENTITIES.find((x) => x === name);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/** Synced columns of a project. Never synced: `root_path`. */
export interface SubjectData {
  name: string;
  /** Palette key, e.g. "teal". */
  color: string;
  parent_id: string | null;
  position: number;
  created_at: string;
  deleted_at: string | null;
  /** A group holds sub-projects and no task (protocol 3; absent = `false`). */
  is_group: boolean;
}

/** Synced columns of a section (hard-deleted: a tombstone when gone). Never: `subpath`. */
export interface SectionData {
  subject_id: string;
  name: string;
  position: number;
  created_at: string;
}

/** Synced columns of a task or sub-task. Never synced: `workdir_override`. */
export interface TaskData {
  subject_id: string | null;
  section_id: string | null;
  parent_id: string | null;
  title: string;
  /** The task's note. */
  description: string;
  due_date: string | null;
  due_time: string | null;
  /** 1 to 4. */
  priority: number;
  completed_at: string | null;
  position: number;
  created_at: string;
  deleted_at: string | null;
  /** Kanban column of the task (protocol 3; absent = `null`). */
  board_column_id: string | null;
}

/** Synced columns of a Kanban column (protocol 3); `subject_id: null` = « Sans projet ». */
export interface BoardColumnData {
  subject_id: string | null;
  name: string;
  position: number;
  is_done: boolean;
  created_at: string;
}

export type SegmentSource = "auto" | "manual";
export type StopReason = (typeof STOP_REASONS)[number];

/** Synced columns of a time segment (protocol 3). Never synced: `agent_session_id`. */
export interface TimeSegmentData {
  task_id: string;
  source: SegmentSource;
  /** Canonical UTC instant. */
  started_at: string;
  /** Canonical UTC instant, `>= started_at`; `null` while the segment runs. */
  ended_at: string | null;
  stop_reason: StopReason | null;
  note: string;
  created_at: string;
  deleted_at: string | null;
}

export type RelationKind = "blocks" | "relates_to";

/** Synced columns of a task relation (protocol 3). */
export interface RelationData {
  from_task_id: string;
  to_task_id: string;
  kind: RelationKind;
  created_at: string;
  deleted_at: string | null;
}

/**
 * Synced columns of an attachment (protocol 3). Never synced: `stored_path`. The file itself
 * travels apart, in chunks.
 */
export interface AttachmentData {
  task_id: string;
  /** No `/` or `\`, 1 to `MAX_FILE_NAME_BYTES` bytes. */
  file_name: string;
  mime_type: string;
  size: number;
  /**
   * SHA-256 of the file: 64 lowercase hexadecimal characters. Additive and optional (the
   * protocol stays 3): absent or `null` when unknown; Rust leaves it out of the JSON then.
   */
  sha256?: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** Synced columns of a notebook group (hard-deleted: a tombstone; its pages lose the group). */
export interface NoteGroupData {
  subject_id: string;
  /** Not blank. */
  name: string;
  position: number;
  created_at: string;
}

export type NoteKind = (typeof NOTE_KINDS)[number];

/** Synced columns of a notebook page (Markdown body). */
export interface NotePageData {
  subject_id: string;
  /** `null` = outside any group. */
  group_id: string | null;
  kind: NoteKind;
  /** Not blank, at most `MAX_NOTE_TITLE_BYTES` bytes. */
  title: string;
  /** Markdown, at most `MAX_NOTE_BODY_BYTES` bytes. */
  body: string;
  /** The task a summary was written for. */
  source_task_id: string | null;
  /** Set = shown in « Épinglées », ordered by this stamp. */
  pinned_at: string | null;
  position: number;
  created_at: string;
  deleted_at: string | null;
}

/** An image of a notebook page: same shape as `AttachmentData`, `note_page_id` instead of `task_id`. */
export interface NoteAttachmentData {
  note_page_id: string;
  /** No `/` or `\`, 1 to `MAX_FILE_NAME_BYTES` bytes. */
  file_name: string;
  mime_type: string;
  size: number;
  /** Same as `AttachmentData.sha256`. */
  sha256?: string | null;
  created_at: string;
  deleted_at: string | null;
}

/**
 * One shared setting (protocol 2); the change id is the key. Never deleted: a setting has no
 * tombstone. `value` is any JSON value; known keys constrain it (see `validateChange`).
 */
export interface SettingData {
  value: unknown;
}

interface Versioned<E extends Entity, T> {
  entity: E;
  id: string;
  updated_at: string;
  /** Ignored in a push (the server stamps the token's device); set in a pull. */
  device_id: string;
  /** `null` = tombstone: gone for good, always wins, never comes back. */
  data: T | null;
}

export type SubjectChange = Versioned<"subject", SubjectData>;
export type SectionChange = Versioned<"section", SectionData>;
export type TaskChange = Versioned<"task", TaskData>;
export type SettingChange = Versioned<"setting", SettingData>;
export type BoardColumnChange = Versioned<"board_column", BoardColumnData>;
export type TimeSegmentChange = Versioned<"time_segment", TimeSegmentData>;
export type RelationChange = Versioned<"relation", RelationData>;
export type AttachmentChange = Versioned<"attachment", AttachmentData>;
export type NoteGroupChange = Versioned<"note_group", NoteGroupData>;
export type NotePageChange = Versioned<"note_page", NotePageData>;
export type NoteAttachmentChange = Versioned<
  "note_attachment",
  NoteAttachmentData
>;
export type Change =
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

export interface SyncRequest {
  protocol: number;
  /** Highest server revision applied here; 0 = never synced (full pull). */
  cursor: number;
  changes: Change[];
  /**
   * Wire names of the entities this client reads (additive, protocol 3). Absent = a client
   * made before the notebook: the server sends it `LEGACY_ENTITIES` rows only.
   */
  known_entities?: string[];
}

export interface ChangeKey {
  entity: Entity;
  id: string;
}

export interface SyncResponse {
  protocol: number;
  /** Identity of the server database; another value than the stored one = reset (§ 2.6). */
  server_epoch: string;
  /** Highest revision once the push is stored, or the last returned row's when `has_more`. */
  cursor: number;
  /** Apply as is, in order (docs/SYNC.md § 2.5). */
  changes: Change[];
  /** More rows wait above `cursor`: ask again at once. */
  has_more: boolean;
  /** Pushed changes that failed validation (not stored): drop from the outbox, log. */
  rejected: ChangeKey[];
  accepted: number;
  server_time: string;
}

/** `POST /api/signup` (protocol 3): answers with a `LoginResponse`. */
export interface SignupRequest {
  protocol: number;
  email: string;
  password: string;
  device_name: string;
}

export interface LoginRequest {
  protocol: number;
  email: string;
  password: string;
  device_name: string;
}

/** `POST /api/password/forgot`: always answered 204. */
export interface ForgotRequest {
  protocol: number;
  email: string;
}

/** `POST /api/password/reset`: new password from the e-mailed code. */
export interface ResetRequest {
  protocol: number;
  email: string;
  code: string;
  password: string;
}

/** `GET /api/account`. */
export interface AccountResponse {
  protocol: number;
  email: string;
  created_at: string;
  /** Absent from older servers, which did not ask for it: confirmed. */
  email_verified?: boolean;
}

export interface LoginResponse {
  protocol: number;
  token: string;
  device_id: string;
  /** Stored at link; see `SyncResponse.server_epoch`. */
  server_epoch: string;
}

export interface HealthResponse {
  ok: boolean;
  protocol: number;
}

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "rate_limited"
  | "unsupported_protocol"
  | "payload_too_large"
  | "email_taken"
  | "weak_password"
  | "bad_email"
  | "signups_closed"
  | "invalid_code"
  | "mail_unavailable"
  | "file_too_large"
  | "quota_exceeded"
  | "not_found"
  | "hash_mismatch"
  | "chunk_offset"
  | "internal";

/** Answer of the file status route: how much of an attachment's file the server holds. */
export interface FileStatus {
  protocol: number;
  /** Bytes received so far: the `offset` of the next chunk. */
  received: number;
  /** Total size of the file, as declared by the attachment. */
  size: number;
  /** `true` once all bytes are in and the SHA-256 matched: the file is kept. */
  complete: boolean;
}

export interface ErrorBody {
  error: ErrorCode;
  message: string;
}

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unsupported_protocol: 400,
  unauthorized: 401,
  payload_too_large: 413,
  rate_limited: 429,
  email_taken: 409,
  weak_password: 400,
  bad_email: 400,
  signups_closed: 403,
  invalid_code: 400,
  mail_unavailable: 503,
  file_too_large: 413,
  quota_exceeded: 507,
  not_found: 404,
  hash_mismatch: 400,
  chunk_offset: 409,
  internal: 500,
};

/** `entity:id`, a convenient map key for a row. */
export const changeKey = (c: { entity: Entity; id: string }): string =>
  `${c.entity}:${c.id}`;

// ---------------------------------------------------------------------------
// Conflict rule (same as `incoming_wins` in Rust)
// ---------------------------------------------------------------------------

export interface Stamp {
  updated_at: string;
  device_id: string;
  tombstone: boolean;
}

export const stampOf = (c: Change): Stamp => ({
  updated_at: c.updated_at,
  device_id: c.device_id,
  tombstone: c.data === null,
});

/**
 * Last writer wins, whole row: a stored tombstone is final; an incoming tombstone wins;
 * otherwise the greater (updated_at, device_id) wins, an equal pair wins too. Only the
 * server decides; clients apply what it returns. Exported for tests and the server mirror.
 */
export function incomingWins(incoming: Stamp, stored: Stamp): boolean {
  if (stored.tombstone) return false;
  if (incoming.tombstone) return true;
  if (incoming.updated_at !== stored.updated_at) {
    return incoming.updated_at > stored.updated_at;
  }
  return incoming.device_id >= stored.device_id;
}

/** `stamp` + 1 ms, canonical (`stamp` must be canonical). */
export function stampPlusOneMs(stamp: string): string {
  return new Date(Date.parse(stamp) + 1).toISOString();
}

/**
 * Conflict stamp of a local change (docs/SYNC.md § 2.6): the greatest of the device clock and
 * 1 ms after each lower bound (the row's last known version, the device's last stamp), so a
 * stamp never goes backwards when the clock is late or steps back. `null` bounds are ignored.
 */
export function nextStamp(
  nowIso: string,
  ...lowerBounds: (string | null | undefined)[]
): string {
  let best = nowIso;
  for (const bound of lowerBounds) {
    if (!bound) continue;
    const after = stampPlusOneMs(bound);
    if (after > best) best = after;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Validation (same checks as `Change::validate` in Rust)
// ---------------------------------------------------------------------------

const CANONICAL_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)\.\d{3}Z$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isCanonicalTimestamp = (s: string): boolean =>
  CANONICAL_RE.test(s);

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Exactly 64 characters, each `0-9` or `a-f` (a SHA-256 digest, lowercase hexadecimal). */
export const isSha256Hex = (s: string): boolean => SHA256_RE.test(s);

const SETTING_KEY_RE = /^[a-z0-9_]{1,64}$/;

/** `[a-z0-9_]`, 1 to `MAX_SETTING_KEY_LEN` bytes. */
export const isSettingKey = (key: string): boolean => SETTING_KEY_RE.test(key);

/** Same rules as `check_setting` in Rust; unknown keys are accepted as is. */
function checkSetting(key: string, value: unknown): string | null {
  if (!isSettingKey(key)) return `bad setting key: ${key}`;
  // `JSON.stringify` gives `undefined` for a value JSON cannot carry.
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) return "setting value is not JSON";
  if (utf8Length(json) > MAX_SETTING_VALUE_BYTES) {
    return "setting value is too large";
  }
  if (
    key === SETTING_INBOX_POSITION &&
    !(typeof value === "number" && Number.isFinite(value))
  ) {
    return "inbox_position must be a number";
  }
  return null;
}

function checkId(field: string, id: string | null): string | null {
  if (id === null) return null;
  if (id.trim().length === 0 || utf8Length(id) > MAX_ID_LEN) {
    return `${field} must be 1 to ${MAX_ID_LEN} bytes`;
  }
  return null;
}

const isStopReason = (v: string): boolean =>
  (STOP_REASONS as readonly string[]).includes(v);

function checkStamp(field: string, v: string | null): string | null {
  if (v === null) return null;
  if (v.length === 0 || utf8Length(v) > MAX_STAMP_LEN) {
    return `${field} must be 1 to ${MAX_STAMP_LEN} bytes`;
  }
  return null;
}

/** The file name and optional hash of an attachment or a page image. */
function checkFile(
  fileName: string,
  sha256: string | null | undefined,
): string | null {
  if (
    fileName.trim().length === 0 ||
    utf8Length(fileName) > MAX_FILE_NAME_BYTES ||
    /[/\\]/.test(fileName)
  ) {
    return "file_name must be 1 to 255 bytes without / or \\";
  }
  if (sha256 != null && !isSha256Hex(sha256)) {
    return "sha256 must be 64 lowercase hexadecimal characters";
  }
  return null;
}

/** English reason why the change would be refused (`bad_request`), or `null` when valid. */
export function validateChange(c: Change): string | null {
  const first = (...checks: (string | null)[]) =>
    checks.find((x) => x !== null) ?? null;
  const base = first(
    checkId("id", c.id),
    isCanonicalTimestamp(c.updated_at)
      ? null
      : `updated_at is not a canonical UTC instant: ${c.updated_at}`,
    utf8Length(c.device_id) > MAX_ID_LEN ? "device_id is too long" : null,
  );
  if (base) return base;
  if (c.entity === "setting" && c.data === null) {
    return "a setting is never deleted";
  }
  if (c.data === null) return null;
  const position = (p: number) =>
    Number.isFinite(p) ? null : "position must be a finite number";
  switch (c.entity) {
    case "setting":
      return checkSetting(c.id, (c.data as SettingData).value);
    case "subject": {
      const d = c.data as SubjectData;
      return first(
        position(d.position),
        checkId("parent_id", d.parent_id),
        d.parent_id === c.id ? "a project cannot be its own parent" : null,
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
    case "board_column": {
      const d = c.data as BoardColumnData;
      return first(
        checkId("subject_id", d.subject_id),
        d.name.trim().length === 0 ? "a column name cannot be empty" : null,
        position(d.position),
        checkStamp("created_at", d.created_at),
      );
    }
    case "time_segment": {
      const d = c.data as TimeSegmentData;
      return first(
        checkId("task_id", d.task_id),
        isCanonicalTimestamp(d.started_at)
          ? null
          : `started_at is not a canonical UTC instant: ${d.started_at}`,
        d.ended_at !== null && !isCanonicalTimestamp(d.ended_at)
          ? `ended_at is not a canonical UTC instant: ${d.ended_at}`
          : null,
        d.ended_at !== null && d.ended_at < d.started_at
          ? "ended_at is before started_at"
          : null,
        d.stop_reason !== null && !isStopReason(d.stop_reason)
          ? `bad stop_reason: ${d.stop_reason}`
          : null,
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
    case "relation": {
      const d = c.data as RelationData;
      return first(
        checkId("from_task_id", d.from_task_id),
        checkId("to_task_id", d.to_task_id),
        d.from_task_id === d.to_task_id
          ? "a task cannot be related to itself"
          : null,
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
    case "attachment": {
      const d = c.data as AttachmentData;
      return first(
        checkId("task_id", d.task_id),
        checkFile(d.file_name, d.sha256),
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
    case "note_group": {
      const d = c.data as NoteGroupData;
      return first(
        checkId("subject_id", d.subject_id),
        d.name.trim().length === 0 ? "a group name cannot be empty" : null,
        position(d.position),
        checkStamp("created_at", d.created_at),
      );
    }
    case "note_page": {
      const d = c.data as NotePageData;
      return first(
        checkId("subject_id", d.subject_id),
        checkId("group_id", d.group_id),
        checkId("source_task_id", d.source_task_id),
        (NOTE_KINDS as readonly string[]).includes(d.kind)
          ? null
          : `bad page kind: ${d.kind}`,
        d.title.trim().length === 0 ||
          utf8Length(d.title) > MAX_NOTE_TITLE_BYTES
          ? `a page title must be 1 to ${MAX_NOTE_TITLE_BYTES} bytes, not blank`
          : null,
        utf8Length(d.body) > MAX_NOTE_BODY_BYTES
          ? `a page body must be at most ${MAX_NOTE_BODY_BYTES} bytes`
          : null,
        position(d.position),
        checkStamp("pinned_at", d.pinned_at),
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
    case "note_attachment": {
      const d = c.data as NoteAttachmentData;
      return first(
        checkId("note_page_id", d.note_page_id),
        checkFile(d.file_name, d.sha256),
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
    case "section": {
      const d = c.data as SectionData;
      return first(
        position(d.position),
        checkId("subject_id", d.subject_id),
        checkStamp("created_at", d.created_at),
      );
    }
    case "task": {
      const d = c.data as TaskData;
      return first(
        position(d.position),
        checkId("subject_id", d.subject_id),
        checkId("section_id", d.section_id),
        checkId("parent_id", d.parent_id),
        d.parent_id === c.id ? "a task cannot be its own parent" : null,
        Number.isInteger(d.priority) && d.priority >= 1 && d.priority <= 4
          ? null
          : `priority must be 1 to 4: ${d.priority}`,
        d.due_date !== null && !DATE_RE.test(d.due_date)
          ? `bad due_date: ${d.due_date}`
          : null,
        d.due_time !== null && !TIME_RE.test(d.due_time)
          ? `bad due_time: ${d.due_time}`
          : null,
        d.due_time !== null && d.due_date === null
          ? "due_time without due_date"
          : null,
        checkStamp("completed_at", d.completed_at),
        checkStamp("created_at", d.created_at),
        checkStamp("deleted_at", d.deleted_at),
      );
    }
  }
}
