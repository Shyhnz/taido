import { describe, expect, it } from "vitest";
import requestFixture from "../../crates/sync-proto/fixtures/sync_request.json";
import responseFixture from "../../crates/sync-proto/fixtures/sync_response.json";
import v3Fixture from "../../crates/sync-proto/fixtures/v3_entities.json";
import {
  ALL_ENTITIES,
  type AttachmentData,
  type BoardColumnData,
  type Change,
  changeKey,
  DEFAULT_ACCOUNT_QUOTA_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  EPOCH_STAMP,
  ERROR_HTTP_STATUS,
  type ErrorCode,
  type FileStatus,
  incomingWins,
  isCanonicalTimestamp,
  isSettingKey,
  isSha256Hex,
  knownEntitySet,
  LEGACY_ENTITIES,
  MAX_CHUNK_BYTES,
  MAX_NOTE_BODY_BYTES,
  MAX_NOTE_TITLE_BYTES,
  MAX_SETTING_VALUE_BYTES,
  MAX_SYNC_BODY_BYTES,
  type NoteAttachmentData,
  type NoteGroupData,
  type NotePageData,
  nextStamp,
  PROTOCOL_VERSION,
  type RelationData,
  SETTING_INBOX_POSITION,
  type SettingChange,
  type Stamp,
  type SyncRequest,
  type SyncResponse,
  type TaskChange,
  type TimeSegmentData,
  validateChange,
} from "./sync-proto";

// The same golden files as the Rust tests (crates/sync-proto/src/tests.rs).
const request = requestFixture as SyncRequest;
const response = responseFixture as SyncResponse;

const task = (
  patch: Partial<TaskChange["data"] & object> = {},
): TaskChange => ({
  entity: "task",
  id: "t1",
  updated_at: "2026-10-04T09:00:00.000Z",
  device_id: "dev-a",
  data: {
    subject_id: null,
    section_id: null,
    parent_id: null,
    title: "T",
    description: "",
    due_date: "2026-10-04",
    due_time: "09:30",
    priority: 2,
    completed_at: null,
    position: 1,
    created_at: "2026-10-04T08:00:00.000Z",
    deleted_at: null,
    board_column_id: null,
    ...patch,
  },
});

const setting = (
  id: string,
  value: unknown,
  updated_at = "2026-10-04T09:00:00.000Z",
): SettingChange => ({
  entity: "setting",
  id,
  updated_at,
  device_id: "dev-a",
  data: { value },
});

describe("sync protocol mirror", () => {
  it("reads the shared fixtures and finds them valid", () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(request.protocol).toBe(PROTOCOL_VERSION);
    expect(response.protocol).toBe(PROTOCOL_VERSION);
    expect(request.changes.map((c) => c.entity)).toEqual([
      "subject",
      "subject",
      "section",
      "task",
      "task",
      "section",
      "setting",
    ]);
    expect(request.changes[6]).toMatchObject({
      id: SETTING_INBOX_POSITION,
      data: { value: 2.5 },
    });
    expect(response.changes[2]).toEqual({
      ...setting(SETTING_INBOX_POSITION, 2.5, "2026-10-04T08:45:00.000Z"),
      device_id: "0199a3e0-1111-7000-8000-00000000aaaa",
    });
    for (const c of [...request.changes, ...response.changes]) {
      expect(validateChange(c as Change)).toBeNull();
    }
    expect(response.changes[1].data).toBeNull();
    expect(response.has_more).toBe(false);
    expect(response.rejected).toEqual([
      { entity: "task", id: "0199a3f0-0000-7000-8000-000000000009" },
    ]);
    expect(response.server_epoch).toHaveLength(36);
    expect(isCanonicalTimestamp(response.server_time)).toBe(true);
    expect(JSON.parse(JSON.stringify(request))).toEqual(requestFixture);
    expect(JSON.parse(JSON.stringify(response))).toEqual(responseFixture);
  });

  it("refuses the same changes as the Rust validator", () => {
    expect(validateChange(task())).toBeNull();
    expect(
      validateChange({ ...task(), updated_at: "2026-10-04T09:00:00Z" }),
    ).not.toBeNull();
    expect(validateChange({ ...task(), id: "" })).not.toBeNull();
    expect(validateChange({ ...task(), id: "x".repeat(129) })).not.toBeNull();
    expect(validateChange(task({ priority: 0 }))).not.toBeNull();
    expect(validateChange(task({ priority: 5 }))).not.toBeNull();
    expect(validateChange(task({ priority: 4 }))).toBeNull();
    expect(validateChange(task({ position: Number.NaN }))).not.toBeNull();
    expect(validateChange(task({ due_date: "04/10/2026" }))).not.toBeNull();
    expect(validateChange(task({ due_time: "24:00" }))).not.toBeNull();
    expect(validateChange(task({ due_date: null }))).not.toBeNull();
    expect(validateChange(task({ parent_id: "t1" }))).not.toBeNull();
    expect(validateChange(task({ created_at: "" }))).not.toBeNull();
    expect(validateChange(task({ title: "a".repeat(100_000) }))).toBeNull();
    expect(validateChange({ ...task(), data: null })).toBeNull();
  });

  it("validates settings like the Rust validator", () => {
    const at = SETTING_INBOX_POSITION;
    expect(validateChange(setting(at, 2.5))).toBeNull();
    expect(validateChange(setting(at, -3))).toBeNull();
    expect(validateChange(setting(at, "2.5"))).toBe(
      "inbox_position must be a number",
    );
    expect(validateChange(setting(at, null))).not.toBeNull();
    expect(validateChange(setting(at, Number.NaN))).not.toBeNull();
    expect(validateChange(setting(at, { v: 1 }))).not.toBeNull();
    // Never deleted, whatever the key.
    expect(validateChange({ ...setting(at, 1), data: null })).toBe(
      "a setting is never deleted",
    );
    expect(validateChange({ ...setting("theme_x", 1), data: null })).not.toBe(
      null,
    );
    // Keys: `[a-z0-9_]`, 1 to 64 bytes.
    for (const bad of ["Inbox", "a-b", "é", "", "a".repeat(65)]) {
      expect(validateChange(setting(bad, 1))).not.toBeNull();
    }
    expect(validateChange(setting("a".repeat(64), 1))).toBeNull();
    expect(
      validateChange(setting("theme_x_2", { dark: true, list: [1, 2] })),
    ).toBeNull();
    expect(isSettingKey(SETTING_INBOX_POSITION)).toBe(true);
    expect(isSettingKey("inbox.position")).toBe(false);
    // Value size, serialized (a string carries its two quotes).
    const big = (n: number) => setting("theme_x", "a".repeat(n));
    expect(validateChange(big(MAX_SETTING_VALUE_BYTES - 2))).toBeNull();
    expect(validateChange(big(MAX_SETTING_VALUE_BYTES - 1))).toBe(
      "setting value is too large",
    );
    expect(validateChange(big(5000))).not.toBeNull();
    expect(validateChange(setting("theme_x", undefined))).not.toBeNull();
    // The generic checks still run.
    expect(
      validateChange(setting(at, 1, "2026-10-04T09:00:00Z")),
    ).not.toBeNull();
    // Existing entities still check their position.
    expect(validateChange(task({ position: Number.POSITIVE_INFINITY }))).toBe(
      "position must be a finite number",
    );
    expect(changeKey(setting(at, 1))).toBe("setting:inbox_position");
  });

  it("applies the conflict rule like the server", () => {
    const s = (
      updated_at: string,
      device_id: string,
      tombstone = false,
    ): Stamp => ({
      updated_at,
      device_id,
      tombstone,
    });
    const t1 = "2026-10-04T09:00:00.000Z";
    const t2 = "2026-10-04T09:00:00.001Z";
    expect(incomingWins(s(t2, "a"), s(t1, "b"))).toBe(true);
    expect(incomingWins(s(t1, "b"), s(t2, "a"))).toBe(false);
    expect(incomingWins(s(t1, "b"), s(t1, "a"))).toBe(true);
    expect(incomingWins(s(t1, "a"), s(t1, "b"))).toBe(false);
    expect(incomingWins(s(t1, "a"), s(t1, "a"))).toBe(true);
    expect(incomingWins(s(t1, "a", true), s(t2, "z"))).toBe(true);
    expect(incomingWins(s(t2, "z"), s(t1, "a", true))).toBe(false);
    expect(changeKey(task())).toBe("task:t1");
  });

  it("accepts what toISOString produces", () => {
    expect(isCanonicalTimestamp(new Date(0).toISOString())).toBe(true);
    expect(isCanonicalTimestamp("2026-10-04T09:00:00.000+00:00")).toBe(false);
  });

  it("makes monotonic stamps that beat the epoch stamp", () => {
    const now = "2026-10-04T10:01:00.000Z";
    expect(nextStamp(now)).toBe(now);
    expect(nextStamp(now, null, undefined, EPOCH_STAMP)).toBe(now);
    // The row was last stamped 10:03 by a device whose clock is fast.
    expect(nextStamp(now, "2026-10-04T10:03:00.000Z")).toBe(
      "2026-10-04T10:03:00.001Z",
    );
    expect(
      nextStamp(now, "2026-10-04T10:00:00.000Z", "2026-10-04T10:01:00.999Z"),
    ).toBe("2026-10-04T10:01:01.000Z");
    expect(isCanonicalTimestamp(EPOCH_STAMP)).toBe(true);
    const real: Stamp = { updated_at: now, device_id: "a", tombstone: false };
    const epoch: Stamp = {
      updated_at: EPOCH_STAMP,
      device_id: "z",
      tombstone: false,
    };
    expect(incomingWins(epoch, real)).toBe(false);
  });
});

describe("sync protocol 3 mirror", () => {
  const AT = "2026-10-10T09:00:00.000Z";
  const wrap = <E extends Change["entity"]>(
    entity: E,
    id: string,
    data: unknown,
  ) =>
    ({ entity, id, updated_at: AT, device_id: "d", data }) as unknown as Change;

  const column = (patch: Partial<BoardColumnData> = {}) =>
    wrap("board_column", "col-s1-0", {
      subject_id: "s1",
      name: "À valider",
      position: 1,
      is_done: false,
      created_at: AT,
      ...patch,
    });
  const segment = (patch: Partial<TimeSegmentData> = {}) =>
    wrap("time_segment", "seg1", {
      task_id: "t1",
      source: "auto",
      started_at: "2026-10-10T08:00:00.000Z",
      ended_at: "2026-10-10T08:30:00.000Z",
      stop_reason: "waiting",
      note: "",
      created_at: AT,
      deleted_at: null,
      ...patch,
    });
  const relation = (patch: Partial<RelationData> = {}) =>
    wrap("relation", "r1", {
      from_task_id: "t1",
      to_task_id: "t2",
      kind: "blocks",
      created_at: AT,
      deleted_at: null,
      ...patch,
    });
  const attachment = (patch: Partial<AttachmentData> = {}) =>
    wrap("attachment", "a1", {
      task_id: "t1",
      file_name: "plan.pdf",
      mime_type: "application/pdf",
      size: 1234,
      created_at: AT,
      deleted_at: null,
      ...patch,
    });

  it("reads the shared v3 fixture and finds it valid", () => {
    const req = v3Fixture as SyncRequest;
    expect(req.protocol).toBe(3);
    expect(req.changes.map((c) => c.entity)).toEqual([
      "subject",
      "task",
      "board_column",
      "time_segment",
      "relation",
      "attachment",
      "relation",
      "note_group",
      "note_page",
      "note_attachment",
    ]);
    for (const c of req.changes) expect(validateChange(c)).toBeNull();
    expect(req.changes[6].data).toBeNull();
    expect(JSON.parse(JSON.stringify(req))).toEqual(v3Fixture);
  });

  const noteGroup = (patch: Partial<NoteGroupData> = {}) =>
    wrap("note_group", "g1", {
      subject_id: "s1",
      name: "Décisions",
      position: 1,
      created_at: AT,
      ...patch,
    });
  const notePage = (patch: Partial<NotePageData> = {}) =>
    wrap("note_page", "p1", {
      subject_id: "s1",
      group_id: "g1",
      kind: "page",
      title: "Style des mails",
      body: "Bleu nuit",
      source_task_id: null,
      pinned_at: null,
      position: 1,
      created_at: AT,
      deleted_at: null,
      ...patch,
    });
  const noteAttachment = (patch: Partial<NoteAttachmentData> = {}) =>
    wrap("note_attachment", "a1", {
      note_page_id: "p1",
      file_name: "maquette.png",
      mime_type: "image/png",
      size: 2048,
      created_at: AT,
      deleted_at: null,
      ...patch,
    });

  it("lists the entities like Rust, legacy ones first", () => {
    expect(ALL_ENTITIES).toHaveLength(11);
    expect(ALL_ENTITIES.slice(0, 8)).toEqual([...LEGACY_ENTITIES]);
    expect((v3Fixture as SyncRequest).known_entities).toEqual([
      ...ALL_ENTITIES,
    ]);
    expect(knownEntitySet(undefined)).toEqual([...LEGACY_ENTITIES]);
    const known = knownEntitySet(["note_page", "later_thing", "task"]);
    expect(known).toContain("note_page");
    expect(known).not.toContain("note_group");
    expect(known).not.toContain("later_thing");
  });

  it("has the notebook limits of Rust", () => {
    expect(MAX_NOTE_BODY_BYTES).toBe(262_144);
    expect(MAX_NOTE_TITLE_BYTES).toBe(500);
  });

  it("validates notebook groups like Rust", () => {
    expect(validateChange(noteGroup())).toBeNull();
    expect(validateChange(noteGroup({ name: "  " }))).not.toBeNull();
    expect(validateChange(noteGroup({ subject_id: "" }))).not.toBeNull();
    expect(validateChange(noteGroup({ position: Number.NaN }))).not.toBeNull();
  });

  it("validates notebook pages like Rust", () => {
    expect(validateChange(notePage())).toBeNull();
    expect(validateChange(notePage({ kind: "summary" }))).toBeNull();
    expect(validateChange(notePage({ group_id: null }))).toBeNull();
    expect(validateChange(notePage({ pinned_at: AT }))).toBeNull();
    expect(
      validateChange(notePage({ kind: "draft" as NotePageData["kind"] })),
    ).not.toBeNull();
    expect(validateChange(notePage({ title: "" }))).not.toBeNull();
    expect(validateChange(notePage({ title: "   " }))).not.toBeNull();
    expect(validateChange(notePage({ title: "a".repeat(500) }))).toBeNull();
    expect(validateChange(notePage({ title: "a".repeat(501) }))).not.toBeNull();
    expect(
      validateChange(notePage({ body: "a".repeat(MAX_NOTE_BODY_BYTES) })),
    ).toBeNull();
    expect(
      validateChange(notePage({ body: "a".repeat(MAX_NOTE_BODY_BYTES + 1) })),
    ).not.toBeNull();
    // Bytes, not characters.
    expect(
      validateChange(
        notePage({ body: "é".repeat(MAX_NOTE_BODY_BYTES / 2 + 1) }),
      ),
    ).not.toBeNull();
    expect(validateChange(notePage({ group_id: "" }))).not.toBeNull();
    expect(validateChange(notePage({ source_task_id: "" }))).not.toBeNull();
    expect(validateChange(notePage({ pinned_at: "" }))).not.toBeNull();
    expect(
      validateChange(notePage({ position: Number.POSITIVE_INFINITY })),
    ).not.toBeNull();
  });

  it("validates notebook images like Rust", () => {
    expect(validateChange(noteAttachment())).toBeNull();
    for (const bad of ["a/b.png", "a\\b.png", " ", "a".repeat(256)]) {
      expect(validateChange(noteAttachment({ file_name: bad }))).not.toBeNull();
    }
    expect(validateChange(noteAttachment({ note_page_id: "" }))).not.toBeNull();
    expect(
      validateChange(noteAttachment({ sha256: "A".repeat(64) })),
    ).not.toBeNull();
    expect(
      validateChange(noteAttachment({ sha256: "a".repeat(64) })),
    ).toBeNull();
  });

  it("validates board columns like Rust", () => {
    expect(validateChange(column())).toBeNull();
    expect(validateChange(column({ subject_id: null }))).toBeNull();
    expect(validateChange(column({ name: "" }))).not.toBeNull();
    expect(validateChange(column({ name: "   " }))).not.toBeNull();
    expect(validateChange(column({ position: Number.NaN }))).not.toBeNull();
    expect(validateChange(column({ subject_id: "" }))).not.toBeNull();
    expect(
      validateChange(column({ subject_id: "x".repeat(129) })),
    ).not.toBeNull();
    expect(validateChange(column({ created_at: "" }))).not.toBeNull();
  });

  it("validates time segments like Rust", () => {
    expect(validateChange(segment())).toBeNull();
    expect(validateChange(segment({ ended_at: null }))).toBeNull();
    expect(validateChange(segment({ stop_reason: null }))).toBeNull();
    expect(
      validateChange(segment({ ended_at: "2026-10-10T08:00:00.000Z" })),
    ).toBeNull();
    expect(validateChange(segment({ task_id: "" }))).not.toBeNull();
    expect(
      validateChange(segment({ started_at: "2026-10-10T08:00:00Z" })),
    ).not.toBeNull();
    expect(validateChange(segment({ ended_at: "nope" }))).not.toBeNull();
    expect(
      validateChange(segment({ ended_at: "2026-10-10T07:59:59.999Z" })),
    ).not.toBeNull();
    for (const reason of [
      "waiting",
      "turn_ended",
      "session_closed",
      "task_done",
      "app_closed",
    ] as const) {
      expect(validateChange(segment({ stop_reason: reason }))).toBeNull();
    }
    expect(
      validateChange(segment({ stop_reason: "crash" as never })),
    ).not.toBeNull();
    expect(
      validateChange(segment({ stop_reason: "" as never })),
    ).not.toBeNull();
    expect(validateChange(segment({ deleted_at: "" }))).not.toBeNull();
    expect(validateChange(segment({ note: "a".repeat(100_000) }))).toBeNull();
  });

  it("validates relations like Rust", () => {
    expect(validateChange(relation())).toBeNull();
    expect(validateChange(relation({ kind: "relates_to" }))).toBeNull();
    expect(validateChange(relation({ to_task_id: "t1" }))).not.toBeNull();
    expect(validateChange(relation({ from_task_id: "" }))).not.toBeNull();
    expect(
      validateChange(relation({ to_task_id: "x".repeat(129) })),
    ).not.toBeNull();
  });

  it("validates attachments like Rust", () => {
    expect(validateChange(attachment())).toBeNull();
    for (const bad of [
      "",
      "  ",
      "a/b.pdf",
      "a\\b.pdf",
      "a".repeat(256),
      "é".repeat(128),
    ]) {
      expect(validateChange(attachment({ file_name: bad }))).not.toBeNull();
    }
    expect(
      validateChange(attachment({ file_name: "a".repeat(255) })),
    ).toBeNull();
    expect(validateChange(attachment({ task_id: "" }))).not.toBeNull();
    expect(validateChange(attachment({ size: 0 }))).toBeNull();
  });

  const HASH =
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  it("keeps the optional sha256 of an attachment, well formed or absent", () => {
    // The shared fixture carries an example hash and must round trip with it.
    const fixtureAttachment = (v3Fixture as SyncRequest).changes.find(
      (c) => c.entity === "attachment",
    ) as Change & { data: AttachmentData };
    expect(fixtureAttachment.data.sha256).toBe(HASH);

    expect(validateChange(attachment())).toBeNull(); // absent
    expect(validateChange(attachment({ sha256: null }))).toBeNull();
    expect(validateChange(attachment({ sha256: HASH }))).toBeNull();
    expect(validateChange(attachment({ sha256: "0".repeat(64) }))).toBeNull();
    for (const bad of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      HASH.toUpperCase(),
      `g${HASH.slice(1)}`,
      ` ${HASH.slice(1)}`,
      `${HASH.slice(1)}\n`,
      "é".repeat(32),
    ]) {
      expect(validateChange(attachment({ sha256: bad }))).not.toBeNull();
    }
  });

  it("recognises a SHA-256 digest like is_sha256_hex in Rust", () => {
    expect(isSha256Hex(HASH)).toBe(true);
    expect(isSha256Hex(HASH.toUpperCase())).toBe(false);
    expect(isSha256Hex(HASH.slice(1))).toBe(false);
    // A trailing newline is not part of a digest.
    expect(isSha256Hex(`${HASH}\n`)).toBe(false);
    expect(isSha256Hex("")).toBe(false);
  });

  it("has the file limits of the Rust crate", () => {
    expect(MAX_CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(104_857_600);
    expect(DEFAULT_ACCOUNT_QUOTA_BYTES).toBe(2_147_483_648);
    expect(MAX_CHUNK_BYTES).toBeLessThanOrEqual(MAX_SYNC_BODY_BYTES);
  });

  it("types the file status answer", () => {
    const status: FileStatus = {
      protocol: PROTOCOL_VERSION,
      received: 8_388_608,
      size: 62_914_560,
      complete: false,
    };
    expect(JSON.parse(JSON.stringify(status))).toEqual({
      protocol: 3,
      received: 8_388_608,
      size: 62_914_560,
      complete: false,
    });
  });

  it("maps the file error codes to the Rust statuses", () => {
    const expected: [ErrorCode, number][] = [
      ["file_too_large", 413],
      ["quota_exceeded", 507],
      ["not_found", 404],
      ["hash_mismatch", 400],
      ["chunk_offset", 409],
    ];
    for (const [code, status] of expected) {
      expect(ERROR_HTTP_STATUS[code]).toBe(status);
    }
  });

  it("accepts tombstones of the new entities", () => {
    for (const e of [
      "board_column",
      "time_segment",
      "relation",
      "attachment",
      "note_group",
      "note_page",
      "note_attachment",
    ] as const) {
      expect(validateChange(wrap(e, "x", null))).toBeNull();
      expect(validateChange(wrap(e, "", null))).not.toBeNull();
    }
  });

  it("maps the new error codes to the Rust statuses", () => {
    expect(ERROR_HTTP_STATUS.email_taken).toBe(409);
    expect(ERROR_HTTP_STATUS.weak_password).toBe(400);
    expect(ERROR_HTTP_STATUS.bad_email).toBe(400);
    expect(ERROR_HTTP_STATUS.invalid_code).toBe(400);
    expect(ERROR_HTTP_STATUS.mail_unavailable).toBe(503);
  });
});
